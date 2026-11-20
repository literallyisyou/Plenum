import { BUSINESS_FUNDS_TOOL, businessFunds } from '../business-funds.mjs';

export const tools = [{
  name: BUSINESS_FUNDS_TOOL,
  description: 'List eligible business vendor invoices or submit one existing invoice using the owner’s delegated funds. Use the exact invoice ID. A submitted payment may still be pending settlement. Check the same invoice if submission was ambiguous.',
  input_schema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['list', 'pay'] },
      invoiceId: { type: 'string', description: 'Required for pay. Use the exact invoice ID returned by list.' },
    },
    required: ['action'],
    additionalProperties: false,
  },
  scoped: 'off',
  refusal: 'A delegated worker cannot access business funds.',
  when: businessFunds.available,
  run: businessFunds.run,
}];
