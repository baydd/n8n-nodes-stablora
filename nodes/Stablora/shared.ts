import { createHmac, timingSafeEqual } from 'crypto';
import type {
	IDataObject,
	IExecuteFunctions,
	IHookFunctions,
	IHttpRequestMethods,
	IWebhookFunctions,
} from 'n8n-workflow';

export const CREDENTIAL = 'stabloraApi';
const DECIMAL = /^(?:0|[1-9]\d{0,17})(?:\.\d{1,18})?$/;

/** 'live' (qk_live_) or 'test' (qk_test_); null when malformed. */
export function keyMode(key: unknown): 'live' | 'test' | null {
	const match = /^qk_(live|test)_[A-Za-z0-9_-]+$/.exec(String(key ?? ''));
	return match ? (match[1] as 'live' | 'test') : null;
}

/** A live key acts only on live payments, a test key only on sandbox/testnet ones. */
export function modeMatches(mode: unknown, key: unknown): boolean {
	const k = keyMode(key);
	return k === 'live' ? mode === 'live' : k === 'test' && (mode === 'sandbox' || mode === 'testnet');
}

export function positiveDecimal(value: unknown, name: string): string {
	const text = String(value ?? '').trim();
	if (!DECIMAL.test(text) || /^0(?:\.0+)?$/.test(text)) {
		throw new Error(`${name} must be a positive decimal such as 19.99`);
	}
	return text;
}

export function baseUrl(credentials: IDataObject): string {
	const url = new URL(String(credentials.baseUrl || 'https://stablora.xyz/api/v1').replace(/\/$/, ''));
	if (url.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(url.hostname)) {
		throw new Error('The Stablora API base URL must use https://');
	}
	return url.href.replace(/\/$/, '');
}

type Context = IExecuteFunctions | IHookFunctions | IWebhookFunctions;

/** Authenticated request through n8n's credential helper. */
export async function api(
	context: Context,
	method: IHttpRequestMethods,
	path: string,
	body?: IDataObject,
	query?: IDataObject,
): Promise<IDataObject> {
	const credentials = await context.getCredentials(CREDENTIAL);
	return (await context.helpers.httpRequestWithAuthentication.call(context, CREDENTIAL, {
		method,
		url: `${baseUrl(credentials)}${path}`,
		json: true,
		...(body ? { body } : {}),
		...(query ? { qs: query } : {}),
	})) as IDataObject;
}

export interface StabloraEvent extends IDataObject {
	id: string;
	type: string;
	mode?: string;
	createdAt?: string;
	data?: IDataObject;
}

/**
 * Stablora-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">. Checked on the
 * exact bytes, constant time, 300 s tolerance. Returns the parsed event or throws.
 */
export function verifySignature(
	raw: Buffer | string | undefined,
	header: unknown,
	secret: unknown,
	now: number = Math.floor(Date.now() / 1000),
): StabloraEvent {
	if (typeof secret !== 'string' || !secret) {
		throw new Error('This trigger has no signing secret; switch the workflow off and on again.');
	}
	const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw ?? ''), 'utf8');
	let t: string | null = null;
	const sigs: Buffer[] = [];
	for (const part of String(header ?? '').split(',')) {
		const [k, v] = part.trim().split('=');
		if (k === 't' && /^\d+$/.test(v || '')) t = v;
		if (k === 'v1' && /^[a-f0-9]{64}$/i.test(v || '')) sigs.push(Buffer.from(v, 'hex'));
	}
	if (!t || !sigs.length) throw new Error('Missing or malformed Stablora-Signature header');
	if (Math.abs(now - Number(t)) > 300) throw new Error('Webhook timestamp outside the 5 minute tolerance');
	const expected = createHmac('sha256', secret).update(`${t}.`).update(bytes).digest();
	if (!sigs.some((s) => s.length === expected.length && timingSafeEqual(s, expected))) {
		throw new Error('Invalid Stablora signature');
	}
	const event = JSON.parse(bytes.toString('utf8')) as StabloraEvent;
	if (!event || typeof event !== 'object' || typeof event.id !== 'string' || typeof event.type !== 'string') {
		throw new Error('Invalid event');
	}
	return event;
}
