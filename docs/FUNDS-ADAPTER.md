# Business funds adapter

Plenum can submit existing vendor invoices against a delegated business account when the operator installs a compatible local adapter. The adapter is supplied and operated by whoever administers that account. Plenum ships the tool and protocol. The local service and institution-specific integration must be supplied separately. At setup, confirm the account and cap with the institution, then verify the adapter against a sandbox before granting a real allowance.

Set the business leads and identify the exact business ID and project ID from Plenum. Add `business-funds.json` in the Plenum state directory (`MUSE_CONSOLE_HOME` when set, otherwise `~/.muse-console`). Restrict that directory and file to the Plenum operator account and keep them outside model workspaces. Protect the adapter service and its signing key with operating-system permissions. Configure a business account credential in the adapter with just the invoice capability and revoke the allowance there when stopping use. A model with unrestricted operating-system access under the operator's identity is outside this file-permission boundary. For that setup, run the adapter and credential store as an independently protected service, enforce the caps and delegation at the institution, and keep its signing key inaccessible to untrusted code.

```json
{
  "version": 1,
  "grants": {
    "b_example": {
      "project": "project-id",
      "account": "business-checking-alias",
      "allowance": "supplier-invoices-1",
      "port": 18381,
      "key": "REPLACE_WITH_32_RANDOM_BYTES_AS_LOWERCASE_HEX",
      "currency": "USD",
      "payees": ["approved-vendor-1"],
      "models": ["openai:gpt-6.2-sol"],
      "perInvoice": 2500,
      "total": 10000
    }
  }
}
```

Amounts use the currency's minor unit. `account`, `allowance`, `payees` and invoice IDs are stable opaque identifiers. Use an allowance dedicated to this delegation and a checking or prepaid business account. The service must refuse transfers, unrelated accounts, other payees, credit, loans and newly created invoices through this protocol. A tool call may list eligible invoices or submit an exact invoice ID. The lead must also be listed on the business and run in a writable, tool-enabled chat. Plenum checks the configured model reference selected for the turn. The provider may fulfill that reference through its own aliases or fallback routing.

CLI access is off by default. To grant it for a supported CLI route, add `"allowCliTeam": true` and include its exact model reference, for example `codex:gpt-6.2-sol`. The lead and any native helpers sharing that turn's authenticated CLI bridge can use its invoice allowance. Enable this setting only if you intend to delegate to all of those callers. Plenum's separate delegated workers lack a funds binding.

Remove the grant or replace the file atomically to change it. The file must be outside the project and worktree and cannot have extra hard links. Plenum binds a grant at the start of an eligible turn and rereads it before submission. Start a new turn to use a changed grant. Stop ends the turn and aborts pending network work. A request that reached the adapter may still take effect. Revoke the allowance at the adapter or institution to stop future submissions and reconcile any pending receipt there. Invoice IDs, payee aliases, amounts, and receipts returned to the lead can persist in chat history or provider context and can reach later models in that thread. Revoking authority leaves existing history in place.

## Adapter contract

The adapter listens only on `127.0.0.1` at the configured port. It accepts JSON POST requests at `/plenum-funds/v1`. Each request includes `operation`, `business`, `project`, and `scope`. Scope contains `account`, `allowance`, `currency`, `payees`, `perInvoice` and `total`. The adapter independently confirms the preconfigured business and project binding and intersects the supplied scope with the allowance's account, currency, payees and limits. It must never widen that allowance from values in a request. Connect to the institution using its protected credentials. Do not accept a URL or banking identifiers from model inputs.

Authenticate the exact request body bytes with HMAC-SHA-256 using the 32-byte shared key decoded from hex. The input is the UTF-8 string `plenum-funds-v1\nrequest\n<nonce>\n` followed by the body bytes. The header `X-Plenum-Funds-Mac` contains the lowercase hexadecimal MAC. `X-Plenum-Funds-Nonce` is a Unix millisecond timestamp, a hyphen and 32 lowercase random hex characters. Compare MACs in constant time, reject timestamps outside a short bounded window such as 30 seconds, and atomically refuse previously accepted nonces in that window across processes. Return an HTTP 200 JSON response signed the same way with `response` in place of `request` and the exact same nonce. Keep response bodies under 64 KiB. Plenum gives each call five seconds.

- `list` returns `{ "invoices": [...] }` with at most 100 open invoices whose payees match the grant. Each invoice contains `id`, `quote`, `payee`, `account`, `amount`, `currency`, and `status`. The `quote` is a stable opaque identifier for the exact immutable payable details. For open invoices, use the status `open`.
- `invoice` accepts `invoiceId` and returns that invoice, including its current status. Keep historical submitted and settled quotes addressable even after they leave the open list. If already submitted or settled under this protocol, include `receipt` in the response as the full receipt object described below.
- `pay` accepts `invoice` with `id`, `quote`, `payee`, `account`, `amount`, and `currency`, plus a stable `key` for the account and invoice. Before authorizing it, atomically verify that all fields exactly match the authoritative open payable, reserve against the remaining allowance, and durably journal the payment and key. A repeated key must return or reconcile the same payment, even across restarts, aborted requests or configuration changes. It must never debit twice. Use the institution's durable idempotency or a reconciled atomic mechanism for the external payment, and include in-flight submissions in the aggregate allowance. If a provider lacks those capabilities, refuse the integration. A successful response repeats all exact invoice fields and adds `key`, `receipt` (an opaque receipt identifier) and `status` (`submitted` or `settled`). A verified `submitted` response confirms acceptance for processing. Only `settled` confirms settlement.

Plenum validates responses, checks invoice fields and per-invoice amount, and reuses an invoice key when a response is missing or ambiguous. The adapter and institution enforce the aggregate allowance and own the durable payment journal. If an outcome is unknown, check or retry only the same invoice ID through the adapter, or reconcile the institution's record before authorizing another path. Unconfigured businesses use the usual owner decision workflow.
