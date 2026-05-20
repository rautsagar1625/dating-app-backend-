# Runbook: WebSocket / Socket.IO Incident

**Trigger**: `WebSocketConnectionsDraining` alert, users reporting realtime features broken (messages not arriving, matches not showing), or `velvet_socket_connections_active` drops sharply.

---

## Step 1: Determine scope

```bash
# How many active socket connections?
kubectl exec -n velvet deployment/velvet-api -- \
  node -e "const r=require('ioredis'); const c=new r(process.env.REDIS_URL); c.pubsub('channels','socket.io*').then(ch=>console.log('Active socket.io pub/sub channels:',ch.length)).finally(()=>c.disconnect())"

# Check API pod socket metrics
curl -s https://api.velvet.app/metrics | grep velvet_socket_connections_active

# Check for rapid reconnection storm (sign of auth failure or server error)
kubectl logs -n velvet -l app=velvet-api --tail=100 | grep -i 'socket.*disconnect\|socket.*error'
```

---

## Step 2: Common causes and fixes

### Cause A: Deployment without connection draining

**Symptom**: Connections drop and immediately reconnect. Spike in reconnection events. Happened right after a deployment.

**What happened**: Pods were killed before preStop hook drained connections. Clients reconnect within 1-5s (Socket.IO auto-reconnect with exponential backoff).

**Fix**: Verify preStop hook is configured (it is in `k8s/api-deployment.yaml`). No action needed — clients will reconnect. If reconnects are failing, check if new pods are healthy:
```bash
kubectl get pods -n velvet -l app=velvet-api
kubectl logs -n velvet -l app=velvet-api --tail=20
```

### Cause B: Redis pub/sub adapter failure

**Symptom**: Users can connect and send messages, but messages don't arrive to other users across different pods.

**Why**: Socket.IO Redis Adapter uses Redis pub/sub to fan out events across pods. If Redis pub/sub is down, only users on the same pod can communicate.

**Verify**:
```bash
redis-cli -u $REDIS_URL PUBSUB NUMSUB socket.io#velvet
# Should return non-zero subscriber count if adapter is connected
```

**Fix**: If Redis is down, see `redis-incident.md`. If Redis is up but adapter disconnected:
```bash
kubectl rollout restart deployment/velvet-api -n velvet
```

### Cause C: Sticky session / ingress affinity lost

**Symptom**: WebSocket connections fail to upgrade. Clients loop on polling transport. Browser console shows repeated HTTP requests to `/socket.io/` but no WebSocket upgrade.

**Why**: Socket.IO handshake requires the polling and WebSocket upgrade to hit the same pod. If ingress session affinity broke, the upgrade lands on a different pod that doesn't know about the handshake.

**Verify**:
```bash
kubectl get svc velvet-api-socketio -n velvet -o yaml | grep sessionAffinity
# Should show: sessionAffinity: ClientIP
```

**Fix**:
```bash
kubectl patch svc velvet-api-socketio -n velvet \
  -p '{"spec":{"sessionAffinity":"ClientIP","sessionAffinityConfig":{"clientIP":{"timeoutSeconds":3600}}}}'
```

Or: with Socket.IO Redis Adapter properly configured, you can remove sticky sessions entirely — any pod handles any connection. Verify adapter is active:
```bash
kubectl logs -n velvet -l app=velvet-api --tail=50 | grep -i 'redis.*adapter\|socket.*adapter'
```

### Cause D: Auth token expired for long-lived connections

**Symptom**: Users connected hours ago start getting disconnect events.

**Why**: JWT tokens expire (15m access token). Socket.IO connection auth is checked at connect time only — but if your middleware re-validates on each event, tokens will expire.

**Fix**: Socket connections should auth once at connect (via handshake token) and not re-validate per event. Long-lived connections need a refresh mechanism — the client should silently refresh the access token and reconnect before it expires.

---

## Step 3: Recovery actions

### Rolling restart (most issues)
```bash
# preStop hook gives 5s for connections to drain before SIGTERM
kubectl rollout restart deployment/velvet-api -n velvet
kubectl rollout status deployment/velvet-api -n velvet --timeout=5m
```
Socket.IO clients will auto-reconnect with exponential backoff (1s, 2s, 4s, 8s...). All users reconnected within 30s.

### Communicate to users (if outage > 5 minutes)

Post in-app via push notification or status banner:
```
We're experiencing a brief connectivity issue. 
Your messages are safe — please close and reopen the app.
```

Update status page: `https://status.velvet.app`

---

## Step 4: Prevention

- Ensure `terminationGracePeriodSeconds: 60` in deployment spec (it is)
- Ensure `preStop.exec.command: ["sleep", "5"]` gives ALB/ingress time to deregister pod
- Monitor `velvet_socket_connections_active` — set alert for >20% drop in 5 min window
- Test Socket.IO reconnection in load tests weekly (k6 websocket test)
