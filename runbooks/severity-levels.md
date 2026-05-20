# Incident Severity Levels — Velvet Platform

## Severity Matrix

| Severity | Description | Examples | Response Time | Who |
|----------|-------------|----------|---------------|-----|
| **SEV-1** | Complete outage / data loss risk / security breach | API down, payments down, DB unresponsive, exploit in progress | **5 minutes** — wake people up | IC + All on-call |
| **SEV-2** | Core feature degraded / >10% error rate / revenue impact | Matching broken, auth degraded, queue saturated | **15 minutes** | On-call engineer |
| **SEV-3** | Partial degradation / <10% error rate / non-critical workers failing | Boost feature slow, CDN cache miss spike | **1 hour** | On-call engineer |
| **SEV-4** | Minor bugs / single-user issues | One user can't upload photo, incorrect match count | **Next business day** | Dev team |

---

## Incident Commander (IC) Role

For SEV-1/SEV-2, designate one person as IC. IC responsibilities:
- Owns communication (status page, Slack, internal)
- Does NOT debug — directs others
- Makes go/no-go decisions (rollback, traffic shed)
- Records timeline in #incidents channel with timestamps

---

## Communication Templates

### SEV-1 Slack Message
```
🔴 *SEV-1 INCIDENT DECLARED*
Time: [timestamp UTC]
IC: @[name]
Impact: [what users cannot do]
Status: Investigating
Updates: every 10 min in #incidents
Status page: https://status.velvet.app
```

### Status Page Update (Statuspage.io)
```
Title: [Feature] service disruption
Body: We are investigating an issue affecting [feature]. Users may experience [impact]. Our team is actively working on a fix.
Status: Investigating → Identified → Monitoring → Resolved
```

### Resolution Message
```
✅ *SEV-[N] RESOLVED*
Duration: [X] min
Root cause: [1-line summary]
Impact: [N users affected]
Fix: [what was done]
Post-mortem: within 48h
```

---

## Escalation Contacts

| Role | Primary | Backup |
|------|---------|--------|
| On-call Engineer | PagerDuty rotation | See PagerDuty schedule |
| Engineering Lead | [name] | [name] |
| CTO | [name] | — |
| Legal (GDPR/breach) | [name] | — |
| AWS Support | TAM [name] | AWS Console case |
| Stripe Support | +1-888-926-2289 | dashboard.stripe.com/support |

---

## Timeline Recording

For any SEV-1/SEV-2, record in #incidents:
```
[HH:MM UTC] Alert fired: [alert name]
[HH:MM UTC] IC declared, on-call paged
[HH:MM UTC] Root cause identified: [summary]
[HH:MM UTC] Mitigation applied: [action]
[HH:MM UTC] Service restored
[HH:MM UTC] Post-mortem scheduled for [date]
```
