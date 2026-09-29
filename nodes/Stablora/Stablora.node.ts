import type {
	IDataObject,
	IExecuteFunctions,
	JsonObject,
	INodeExecutionData,
	INodeProperties,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeApiError, NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';
import { api, CREDENTIAL, positiveDecimal } from './shared';

const show = (resource: string, operation: string) => ({ show: { resource: [resource], operation: [operation] } });
const field = (
	displayName: string,
	name: string,
	resource: string,
	operation: string,
	extra: Partial<INodeProperties> = {},
): INodeProperties => ({ displayName, name, type: 'string', default: '', displayOptions: show(resource, operation), ...extra });

/** Stablora actions. Money stays decimal strings end to end; nothing here moves funds out. */
export class Stablora implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Stablora',
		name: 'stablora',
		icon: { light: 'file:stablora.svg', dark: 'file:stablora.dark.svg' },
		group: ['transform'],
		version: 1,
		subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
		description: 'Accept crypto with Stablora: hosted checkouts, invoices, payment links, customer wallets',
		defaults: { name: 'Stablora' },
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		usableAsTool: true,
		credentials: [{ name: CREDENTIAL, required: true }],
		properties: [
			{
				displayName: 'Resource',
				name: 'resource',
				type: 'options',
				noDataExpression: true,
				default: 'checkoutSession',
				options: [
					{ name: 'Balance', value: 'balance' },
					{ name: 'Checkout Session', value: 'checkoutSession', description: 'Fiat price; the customer chooses any coin and network' },
					{ name: 'Customer Wallet', value: 'wallet', description: 'Persistent deposit address per customer (games, top-ups)' },
					{ name: 'Payment', value: 'payment', description: 'Invoice in one fixed coin, or look up a payment' },
					{ name: 'Payment Link', value: 'paymentLink' },
				],
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				default: 'create',
				displayOptions: { show: { resource: ['checkoutSession'] } },
				options: [
					{ name: 'Create', value: 'create', action: 'Create a checkout session', description: 'Returns the checkout URL to send the customer to' },
				],
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				default: 'get',
				displayOptions: { show: { resource: ['payment'] } },
				options: [
					{ name: 'Create', value: 'create', action: 'Create a payment in one coin' },
					{ name: 'Get', value: 'get', action: 'Get a payment', description: 'Authoritative status: use this before fulfilling' },
					{ name: 'Get Many', value: 'getAll', action: 'Get many payments' },
				],
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				default: 'create',
				displayOptions: { show: { resource: ['paymentLink'] } },
				options: [
					{ name: 'Create', value: 'create', action: 'Create a payment link' },
					{ name: 'Get Many', value: 'getAll', action: 'Get many payment links' },
				],
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				default: 'assign',
				displayOptions: { show: { resource: ['wallet'] } },
				options: [
					{ name: 'Assign', value: 'assign', action: 'Assign a customer wallet', description: 'Creates or reuses the customer and their address on a network' },
				],
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				default: 'get',
				displayOptions: { show: { resource: ['balance'] } },
				options: [{ name: 'Get', value: 'get', action: 'Get balances' }],
			},

			field('Reference', 'reference', 'checkoutSession', 'create', { required: true, description: 'Your unique order ID. The same reference returns the same checkout (safe retries).' }),
			field('Amount', 'amount', 'checkoutSession', 'create', { required: true, placeholder: '19.99' }),
			{
				displayName: 'Currency',
				name: 'currency',
				type: 'options',
				default: 'USD',
				displayOptions: show('checkoutSession', 'create'),
				options: [
					{ name: 'EUR', value: 'EUR' },
					{ name: 'GBP', value: 'GBP' },
					{ name: 'USD', value: 'USD' },
				],
			},
			field('Description', 'description', 'checkoutSession', 'create'),
			field('Success URL', 'successUrl', 'checkoutSession', 'create', { description: 'Where the customer can return after paying (https://)' }),
			{
				displayName: 'Coins',
				name: 'options',
				type: 'fixedCollection',
				typeOptions: { multipleValues: true },
				default: {},
				displayOptions: show('checkoutSession', 'create'),
				description: 'Leave empty to offer every coin and network Stablora supports',
				options: [
					{
						name: 'option',
						displayName: 'Coin',
						values: [
							{ displayName: 'Network', name: 'network', type: 'string', default: 'tron', placeholder: 'tron' },
							{ displayName: 'Asset', name: 'asset', type: 'string', default: 'USDT', placeholder: 'USDT' },
						],
					},
				],
			},

			field('Reference', 'reference', 'payment', 'create', { required: true }),
			field('Amount (USD)', 'amount', 'payment', 'create', { required: true, placeholder: '19.99' }),
			field('Network', 'network', 'payment', 'create', { required: true, default: 'tron' }),
			field('Asset', 'asset', 'payment', 'create', { required: true, default: 'USDT' }),
			field('Description', 'description', 'payment', 'create'),
			field('Payment ID', 'paymentId', 'payment', 'get', { required: true, placeholder: 'pay_…' }),
			{
				displayName: 'Limit',
				name: 'limit',
				type: 'number',
				typeOptions: { minValue: 1, maxValue: 100 },
				default: 50,
				description: 'Max number of results to return',
				displayOptions: { show: { resource: ['payment', 'paymentLink'], operation: ['getAll'] } },
			},

			field('Title', 'title', 'paymentLink', 'create', { required: true }),
			field('Fixed Amount (USD)', 'amount', 'paymentLink', 'create', { description: 'Leave empty to let the payer choose (e.g. donations)' }),
			field('Minimum (USD)', 'minAmount', 'paymentLink', 'create'),
			field('Maximum (USD)', 'maxAmount', 'paymentLink', 'create'),

			field('Your Customer ID', 'externalId', 'wallet', 'assign', { required: true, description: 'Your user/player ID' }),
			field('Customer Name', 'name', 'wallet', 'assign'),
			field('Network', 'network', 'wallet', 'assign', { required: true, default: 'tron' }),
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const out: INodeExecutionData[] = [];
		for (let i = 0; i < items.length; i++) {
			try {
				const resource = this.getNodeParameter('resource', i) as string;
				const operation = this.getNodeParameter('operation', i) as string;
				const param = (name: string): string => String(this.getNodeParameter(name, i, '') ?? '').trim();
				const optional = (obj: IDataObject): IDataObject =>
					Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== '' && v !== undefined));
				let result: IDataObject;
				if (resource === 'checkoutSession') {
					const options = this.getNodeParameter('options', i, {}) as { option?: Array<{ network: string; asset: string }> };
					const coins = (options.option || []).map((o) => ({ network: String(o.network).trim(), asset: String(o.asset).trim() }));
					result = await api(this, 'POST', '/checkout-sessions', optional({
						reference: param('reference'),
						amount: positiveDecimal(param('amount'), 'Amount'),
						currency: param('currency') || 'USD',
						description: param('description'),
						successUrl: param('successUrl'),
						options: coins.length ? coins : undefined,
					}));
				} else if (resource === 'payment' && operation === 'create') {
					result = await api(this, 'POST', '/payments', optional({
						reference: param('reference'),
						amount: positiveDecimal(param('amount'), 'Amount'),
						currency: 'USD',
						network: param('network'),
						asset: param('asset'),
						description: param('description'),
					}));
				} else if (resource === 'payment' && operation === 'get') {
					const id = param('paymentId');
					if (!/^[A-Za-z0-9_-]{1,191}$/.test(id)) throw new NodeOperationError(this.getNode(), 'Payment ID is invalid', { itemIndex: i });
					result = await api(this, 'GET', `/payments/${id}`);
				} else if (operation === 'getAll' && (resource === 'payment' || resource === 'paymentLink')) {
					const page = await api(this, 'GET', resource === 'payment' ? '/payments' : '/payment-links', undefined, {
						limit: this.getNodeParameter('limit', i, 50) as number,
					});
					for (const row of (page.data as IDataObject[]) || []) out.push({ json: row, pairedItem: { item: i } });
					continue;
				} else if (resource === 'paymentLink') {
					const amount = param('amount');
					const min = param('minAmount');
					const max = param('maxAmount');
					result = await api(this, 'POST', '/payment-links', optional({
						title: param('title'),
						amount: amount ? positiveDecimal(amount, 'Fixed amount') : undefined,
						minAmount: min ? positiveDecimal(min, 'Minimum') : undefined,
						maxAmount: max ? positiveDecimal(max, 'Maximum') : undefined,
					}));
				} else if (resource === 'wallet') {
					const customer = await api(this, 'POST', '/customers', optional({ externalId: param('externalId'), name: param('name') }));
					const wallet = await api(this, 'POST', '/wallets', { customerId: customer.id, network: param('network') });
					result = { customer, wallet };
				} else if (resource === 'balance') {
					result = await api(this, 'GET', '/balances');
				} else {
					throw new NodeOperationError(this.getNode(), `Unsupported operation ${resource}.${operation}`, { itemIndex: i });
				}
				out.push({ json: result, pairedItem: { item: i } });
			} catch (error) {
				if (this.continueOnFail()) {
					out.push({ json: { error: (error as Error).message }, pairedItem: { item: i } });
					continue;
				}
				if (error instanceof NodeApiError) throw new NodeApiError(this.getNode(), error as unknown as JsonObject, { itemIndex: i });
				throw new NodeOperationError(this.getNode(), error as Error, { itemIndex: i });
			}
		}
		return [out];
	}
}
