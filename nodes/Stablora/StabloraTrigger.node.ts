import type {
	IDataObject,
	IHookFunctions,
	INodeType,
	INodeTypeDescription,
	IWebhookFunctions,
	IWebhookResponseData,
} from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';
import { api, CREDENTIAL, modeMatches, verifySignature, type StabloraEvent } from './shared';

const EVENTS: Array<[string, string]> = [
	['deposit.confirmed', 'Deposit Confirmed (Customer Wallets, Top-Ups)'],
	['deposit.reversed', 'Deposit Reversed'],
	['payment.completed', 'Payment Completed (Paid in Full)'],
	['payment.discrepancy', 'Payment Needs Review (Underpaid, Overpaid, Late or Expired)'],
	['payment.held', 'Payment Held for Compliance Review'],
	['payment.reversed', 'Payment Reversed (Chain Reorganization)'],
	['payout.completed', 'Payout Completed'],
	['payout.failed', 'Payout Failed'],
	['payout.requested', 'Payout Requested'],
	['swap.completed', 'Automatic Conversion Completed'],
];
const SEEN_LIMIT = 500;

interface StaticData extends IDataObject {
	endpointId?: string;
	secret?: string;
	seen?: string[];
}

/**
 * Starts a workflow on signed Stablora events. Activating the workflow registers a webhook endpoint
 * (POST /webhook-endpoints) with its own signing secret; deactivating deletes it. Every delivery is
 * signature-checked, deduplicated by event ID and, for payment events, re-read from the API so the
 * workflow sees the authoritative status, never just the webhook body.
 */
export class StabloraTrigger implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Stablora Trigger',
		name: 'stabloraTrigger',
		icon: { light: 'file:stablora.svg', dark: 'file:stablora.dark.svg' },
		group: ['trigger'],
		version: 1,
		subtitle: '={{$parameter["events"].join(", ")}}',
		description: 'Starts the workflow on verified Stablora payment events',
		defaults: { name: 'Stablora Trigger' },
		inputs: [],
		outputs: [NodeConnectionTypes.Main],
		credentials: [{ name: CREDENTIAL, required: true }],
		webhooks: [{ name: 'default', httpMethod: 'POST', responseMode: 'onReceived', path: 'webhook' }],
		properties: [
			{
				displayName: 'Events',
				name: 'events',
				type: 'multiOptions',
				required: true,
				default: ['payment.completed'],
				options: EVENTS.map(([value, name]) => ({ name, value })),
			},
			{
				displayName: 'Confirm Payment With the API',
				name: 'confirm',
				type: 'boolean',
				default: true,
				description: 'Whether to re-read the payment from Stablora and pass on its current status. Keep on when the workflow delivers goods.',
			},
		],
	};

	webhookMethods = {
		default: {
			async checkExists(this: IHookFunctions): Promise<boolean> {
				const data = this.getWorkflowStaticData('node') as StaticData;
				if (!data.endpointId) return false;
				const list = await api(this, 'GET', '/webhook-endpoints');
				const url = this.getNodeWebhookUrl('default');
				if (((list.data as IDataObject[]) || []).some((e) => e.id === data.endpointId && e.url === url)) return true;
				delete data.endpointId;
				delete data.secret;
				return false;
			},
			async create(this: IHookFunctions): Promise<boolean> {
				const workflow = this.getWorkflow();
				const endpoint = await api(this, 'POST', '/webhook-endpoints', {
					url: this.getNodeWebhookUrl('default'),
					events: this.getNodeParameter('events') as string[],
					label: `n8n · ${workflow.name || workflow.id}`.slice(0, 80),
				});
				if (!endpoint || typeof endpoint.id !== 'string' || typeof endpoint.secret !== 'string') {
					throw new NodeOperationError(this.getNode(), 'Stablora did not return a webhook endpoint');
				}
				const data = this.getWorkflowStaticData('node') as StaticData;
				data.endpointId = endpoint.id;
				data.secret = endpoint.secret;
				data.seen = [];
				return true;
			},
			async delete(this: IHookFunctions): Promise<boolean> {
				const data = this.getWorkflowStaticData('node') as StaticData;
				if (data.endpointId) {
					try {
						await api(this, 'DELETE', `/webhook-endpoints/${data.endpointId}`);
					} catch (error) {
						const e = error as { httpCode?: string; statusCode?: number };
						if (e?.httpCode !== '404' && e?.statusCode !== 404) return false;
					}
				}
				delete data.endpointId;
				delete data.secret;
				delete data.seen;
				return true;
			},
		},
	};

	async webhook(this: IWebhookFunctions): Promise<IWebhookResponseData> {
		const req = this.getRequestObject() as unknown as { rawBody?: Buffer; body?: unknown };
		const res = this.getResponseObject();
		const data = this.getWorkflowStaticData('node') as StaticData;
		const headers = this.getHeaderData() as IDataObject;
		const reject = (status: number, error: string): IWebhookResponseData => {
			res.status(status).json({ error });
			return { noWebhookResponse: true };
		};
		let event: StabloraEvent;
		try {
			// rawBody holds the exact bytes n8n received; the signature covers them, not re-serialized JSON.
			event = verifySignature(req.rawBody ?? JSON.stringify(req.body), headers['stablora-signature'], data.secret);
		} catch (error) {
			return reject(401, (error as Error).message);
		}
		if (headers['stablora-event-id'] !== event.id) return reject(400, 'Event ID header mismatch');
		const { apiKey } = await this.getCredentials(CREDENTIAL);
		// Signed but for the other environment (test events on a live workflow, or the reverse).
		if (event.type === 'test.ping' || !modeMatches(event.mode, apiKey)) return { webhookResponse: { ignored: true } };
		if (!(this.getNodeParameter('events') as string[]).includes(event.type)) return { webhookResponse: { ignored: true } };
		const seen = Array.isArray(data.seen) ? data.seen : [];
		if (seen.includes(event.id)) return { webhookResponse: { duplicate: true } };
		let payment: IDataObject | null = null;
		if (event.type.startsWith('payment.') && this.getNodeParameter('confirm', true)) {
			const id = event.data?.paymentId ?? event.data?.id;
			if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,191}$/.test(id)) return reject(400, 'Event has no payment ID');
			payment = await api(this, 'GET', `/payments/${id}`); // throws → Stablora retries later
			if (!payment || payment.id !== id || !modeMatches(payment.mode, apiKey)) return reject(409, 'Payment does not match the event');
			if (event.type === 'payment.completed' && payment.status !== 'completed') {
				return reject(503, 'Payment not completed yet; retry later');
			}
		}
		data.seen = [...seen, event.id].slice(-SEEN_LIMIT);
		return {
			workflowData: [
				this.helpers.returnJsonArray([
					{
						event: event.type,
						eventId: event.id,
						mode: event.mode,
						createdAt: event.createdAt,
						data: event.data,
						...(payment ? { payment } : {}),
					},
				]),
			],
		};
	}
}
