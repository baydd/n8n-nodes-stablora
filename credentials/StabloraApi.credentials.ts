import type { IAuthenticateGeneric, ICredentialTestRequest, ICredentialType, INodeProperties } from 'n8n-workflow';

/** Secret API key (qk_live_… real payments, qk_test_… testnets) with the read + payments permissions. */
export class StabloraApi implements ICredentialType {
	name = 'stabloraApi';

	displayName = 'Stablora API';

	icon = 'file:stablora.svg' as const;

	documentationUrl = 'https://stablora.xyz/integrations#n8n';

	properties: INodeProperties[] = [
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			required: true,
			description:
				'Dashboard → Developers → API keys. Use "Payments only" permissions. qk_live_ takes real payments; qk_test_ uses testnets.',
		},
		{
			displayName: 'API Base URL',
			name: 'baseUrl',
			type: 'string',
			default: 'https://stablora.xyz/api/v1',
			description: 'Change only for a self-hosted or local Stablora',
		},
	];

	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: { headers: { Authorization: '=Bearer {{$credentials.apiKey}}' } },
	};

	test: ICredentialTestRequest = {
		request: { baseURL: '={{$credentials.baseUrl.replace(/\\/$/, "")}}', url: '/balances' },
	};
}
