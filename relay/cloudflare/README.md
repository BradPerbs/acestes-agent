# Acestes relay on Cloudflare

The relay every device in a fleet connects to, as a Worker with one Durable
Object per fleet. It runs the same core as the Node hub
(`src/main/fleet/relay-core.js`), so the protocol is the same.

It holds the roster, mailboxes, the sync log and job claims. It cannot read
any of it: everything is sealed under the fleet key, which only the devices
have.

## Deploy

```
cd relay/cloudflare
npx wrangler login
npx wrangler deploy
```

Wrangler prints the address, `https://acestes-relay.<your-subdomain>.workers.dev`.
In Acestes, under Settings, Devices, start the fleet with "Relay at an
address" and give it the `wss://` form of that address:

```
wss://acestes-relay.<your-subdomain>.workers.dev
```

Durable Objects with SQLite storage run on the Workers free plan. An idle
fleet costs nothing: sockets hibernate between messages.

## Try it locally

```
npx wrangler dev
```

and use `ws://127.0.0.1:8787` as the relay address.
