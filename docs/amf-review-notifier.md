# AMF review notifier

The notifier has two trust-separated steps:

1. `scan` runs beside the PAM curator. It verifies the authenticated curator ledger, decision receipt, and Fabric ACK outbox before emitting a metadata-only event.
2. `relay` runs beside an already-authenticated OpenClaw gateway. It accepts only the exact event schema, reads the private channel target from an owner-only file, and keeps an owner-only delivery outbox.

The event contains only opaque decision/proposal identifiers, canonical scope, confidence, reason codes, and creation time. Claims, provenance, subject identities, secrets, and channel identifiers are excluded. The relay places a stable decision marker in each private message and reads recent channel history before retrying an uncertain delivery.

```sh
node tools/amf-review-notifier.mjs scan --workspace <workspace-root> --scope room:<canonical-room> --limit 50 > <owner-only-scan-file>
node tools/amf-review-notifier.mjs relay --input <owner-only-scan-file> --state-dir <owner-only-state-dir> --target-file <owner-only-discord-channel-id-file>
```

Keep timer output aggregate-only. Do not log the scan JSON or OpenClaw command arguments.
