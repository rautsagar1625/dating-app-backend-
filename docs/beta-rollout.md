# Velvet — Beta Rollout Strategy

---

## Phase 0: Internal Alpha (Week 1–2)

**Who**: 50 people — employees, founders, friends and family  
**Gate**: Manual invite, zero public marketing

**Technical setup**:
- Feature flag `BETA_ACCESS` enabled for all internal user IDs
- All features on (no flags disabled)
- Sentry alert threshold: 1 occurrence = alert (extreme sensitivity)
- On-call: 24/7 during business hours, senior engineer on standby

**What to validate**:
- Core user flow: signup → onboarding → photo upload → discovery → swipe → match → chat
- Payment: Stripe test + Apple sandbox + Google test purchase
- Push notifications: match alert delivered < 5s
- Crash-free session rate: > 99%
- p95 API latency: < 500ms
- Sentry: 0 new critical error groups

**Success criteria to advance**:
- Zero payment data integrity issues
- < 5 P0/P1 bugs (crashes, data loss)
- All core flows work on both iOS and Android

---

## Phase 1: Closed Beta (Week 3–4)

**Who**: 500 users from waitlist, geographically clustered (1 metro area)  
**Why 1 city**: concentrates the user graph → actual matches happen → real UX feedback

**Technical setup**:
```bash
# Generate 500 invite codes via admin API
curl -X POST https://api.velvet.app/admin/beta/generate-codes \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d '{"count": 500, "expiresIn": "14d"}'
```

- Feature flag `MAX_CONCURRENT_USERS` = 500 (hard cap on active sessions)
- Feature flag `INVITE_CODE_REQUIRED` = enabled
- Feature flag `VIDEO_CALLS` = disabled (save for Phase 3)

**Concurrency ramp**:
- Week 3, Day 1–3: invite first 100 users, monitor for 48h
- Week 3, Day 4–7: invite remaining 400 if no critical issues
- Week 4: full 500 active, 7-day retention measurement

**Key metrics to watch daily**:
| Metric | Target | Action if missed |
|--------|--------|-----------------|
| D1 retention | > 40% | Review onboarding flow |
| Average session length | > 5 min | Review match quality |
| Crash-free sessions | > 99% | P0 triage immediately |
| Match rate per swipe | > 5% | Review recommendation algo |
| Payment conversion | > 0.5% | Review offer timing |
| p95 API latency | < 500ms | Scale or optimize |

**Feedback collection**:
- Day 3: in-app feedback modal (NPS + open text)
- Day 7: in-app feedback modal (feature satisfaction)
- Bug report button always visible in settings
- Slack channel `#beta-feedback` for internal discussion

---

## Phase 2: Open Beta (Week 5–8)

**Who**: 5,000 users, 3 metro areas (geographic expansion)  
**Marketing**: limited — invite links shared by Phase 1 users, small social posts

**Technical setup**:
- Remove invite code requirement
- Set `MAX_SIGNUP_RATE` = 200 new signups/hour (prevents viral spike overwhelming infra)
- Enable feature flag `VOICE_NOTES` (chat feature, low infra cost)
- Geographic-based recommendations enabled for all 3 cities

**Staged geographic rollout**:
1. US West Coast (Week 5)
2. US East Coast (Week 6)  
3. UK / International (Week 7–8)

**Infrastructure milestones**:
- Run WebSocket load test with 5,000 concurrent connections before Week 5
- Scale API to minimum 5 pods before open beta
- Verify BullMQ worker auto-scaling triggers at queue depth > 500

**Feature flag rollout ladder** (A/B tested):
```
NEW_RECOMMENDATION_ALGO:
  Week 5: 5%  → monitor match rate, session time
  Week 6: 25% → if no regression, continue
  Week 7: 75%
  Week 8: 100% → feature flag retired
```

**Success criteria to advance to public launch**:
- D7 retention > 25%
- Crash-free rate > 99.5%
- Payment success rate > 95%
- 0 SEV-1 incidents in final 2 weeks of beta
- Support team handling load (< 4h response to P1 tickets)

---

## Phase 3: Public Launch

**What changes**:
- Remove all signup rate caps (`MAX_SIGNUP_RATE` flag off)
- Enable `VIDEO_CALLS` feature flag (all users)
- App Store: change from TestFlight to full production release
- Android: remove staged rollout cap (100%)
- Launch PR/marketing plan activates

**Launch day ops tempo**:
- T-0 to T+6h: check Grafana every 30 minutes
- T+6h to T+24h: check every hour
- T+24h to T+72h: check every 4 hours
- T+72h: declare "stable," return to normal on-call schedule

**Kill switches available on launch day** (zero-deploy mitigations):
| Feature | Flag | Impact of disabling |
|---------|------|-------------------|
| New recommendation algo | `NEW_RECOMMENDATION_ALGO` | Falls back to previous algo |
| Voice notes | `VOICE_NOTES` | Chat still works |
| Video calls | `VIDEO_CALLS` | Audio still works |
| Boost economy | `BOOST_ENABLED` | Users can't buy boosts (existing active) |
| New offer timing | `NEW_OFFER_ENGINE` | Falls back to previous timing |

---

## Moderation Staffing During Beta

| Phase | Active Users | Moderators | Hours |
|-------|-------------|------------|-------|
| Alpha | 50 | 1 (founder) | 9–6pm |
| Closed Beta | 500 | 1 dedicated | 9am–12am |
| Open Beta | 5,000 | 2 dedicated + 1 on-call | 24/7 (AI handles nights) |
| Launch | 10,000+ | 3–5 based on growth | 24/7 |

**Escalation**:
- Moderator → Trust & Safety Lead: CSAM, threats, doxxing
- Trust & Safety Lead → Legal: law enforcement requests, GDPR data breach

---

## Support Workflow

**Ticket priority**:
- P0 (data loss, double charge): 1h response, any time
- P1 (core feature broken for user): 4h response
- P2 (degraded experience): 24h response
- P3 (enhancement request): weekly review

**Bug triage** (weekly during beta):
1. Categorize all bugs: crash / UX / matching quality / performance / payment / other
2. Top 10 by frequency → assign to sprint
3. Blockers (crash, payment) → immediate fix
4. Share beta summary with team every Monday
