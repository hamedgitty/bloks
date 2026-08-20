# The relay

A pipe between a Mac running Bloks and the phones that belong to it, so the
phone works away from the house wifi.

The relay is deliberately stupid. It cannot read what it carries, it stores
no transcripts, and losing it loses nothing but connectivity.

## What it is not

It is not a host. Agents still run on the user's Mac, with the user's own
provider credentials, exactly as they do today. Shut the lid and the agents
stop, same as before. What the relay buys is **reach** (the phone works
anywhere, not just on the same wifi) and **push** (an approval can buzz a
phone in a pocket).

Hosting the agents themselves would be a different and much larger
thing, and it is not what this is.

## Why it cannot read anything

The whole pitch of Bloks is that your agents, transcripts and keys sit in
`~/.bloks` on your own machine. A relay that terminates TLS and forwards
plaintext would quietly make that false: it would hold every user's agent
conversations, approvals and instructions, and a breach would be all of
them at once.

So the phone and the Mac share a key that the relay never sees, established
during pairing, when the user is physically at both devices reading a six
digit code off the Mac's screen. Everything through the relay is ciphertext
plus the minimum routing metadata needed to move it.

Concretely, the relay learns:

- which space a blob belongs to,
- how big it is and when it arrived,
- that *something* happened worth waking a phone for.

It does not learn what any of it says.

## The consequence for push

A push notification cannot contain content, because the sender cannot read
the content either. An approval arriving while the phone is asleep produces
"An agent needs your approval" and nothing else. Opening the app fetches
and decrypts the real thing.

This is the right design regardless of encryption: notification text is
handled by Apple's infrastructure and shown on a lock screen, which is not
where an agent's instructions belong.

## Shape

A **space** is one user's Bloks: one Mac, one or more phones.

    Mac                          relay                        phone
     |  GET  /space/agent/stream   |                            |
     |<---- commands (SSE) --------|<--- POST /space/client/ask -|
     |  POST /space/agent/result   |---- result --------------->|
     |  POST /space/agent/events   |---- GET /space/client/stream
                                   |---- APNs wake ------------>|

The Mac dials out and keeps one stream open, so nothing has to be
port-forwarded and no inbound firewall rule is ever needed. That is also
why the harness stays a loopback server: the relay link is an outbound
client, not a second listener.
