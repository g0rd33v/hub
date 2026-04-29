# Labs Hub Architecture
**Version:** 0.1 · **Date:** April 30, 2026
**Status:** Architecture finalized from first principles. Hub 0.1 live in production at hub.labs.co.

---

## What Hub Is

Hub is a resilient protocol-level conductor.

It receives any input — a message, an event, a scheduled trigger — and routes it across a live network of connected modules to deliver an answer. It treats every trigger equally. It never asks who you are, only whether your request carries the right to be honored. It never silently fails. Delivery is the only contract.

Hub is not a product. It is infrastructure. The closest analogy is TCP/IP: a routing protocol that became the backbone of the internet by understanding nothing about what it carries and excelling at one thing — moving packets reliably between any two points that wanted to communicate.

Hub does the same thing for intelligence, communication, and computation.

---

## The Core Principle

**Hub never reads, creates, stores, transforms, or judges what it carries.**

This single constraint is the most important architectural decision in the entire system. It is what TCP/IP got right and what most platforms get wrong. Every platform that fails does so because the infrastructure tried to become the application. The kernel is sacred — keep it small, keep it dumb about content, and the system survives every change in what runs on top of it.

Modules read, create, store, transform, and judge. Hub routes.

---

## Three Layers

The architecture has three layers. Everything else is implementation detail.

### Connections

Anything that can produce or consume data plugs in here. APIs, AI models, Telegram bots, websites, databases, IPFS, payment processors, Cloudflare Workers, third-party services, owned infrastructure. Each connection publishes its inputs and outputs to the menu — what it accepts, what it produces, what it costs, what its current state is.

The menu is alive. Things appear when they connect. Things disappear when they fail.

### Credentials

Every request arrives with a capability token. The token is scoped to a specific job — read this file, infer 1000 tokens from this model, write to this KV key, post to this channel. Some tokens are one-time. Some are time-limited. Some are permanent. The credential is the capability. There is no user table, no role matrix, no permission graph — only tokens that entitle specific actions.

This is how the internet works at every layer. HTTP doesn't have permanent users. It has requests with whatever credentials each transaction needs.

### Routing

When a credentialed request arrives, Hub builds a path. Sometimes one hop. Sometimes ten. The path is constructed dynamically from the menu — what's available right now, what has the highest probability of delivery, what has fallback options if the first choice fails.

Hub is reliability-first. Not cost-optimized. The contract is simple: deliver the answer, or honestly report that nothing connected can deliver it. There is no middle state where Hub silently degrades or returns a half-answer without disclosure.

---

## How Routing Works

A task arrives. Hub checks the credential and the credit balance. Hub looks at the live menu. Hub picks the path with the highest probability of successful delivery. If that path fails, Hub immediately reroutes to the next best option. Hub logs every outcome to make future routing decisions smarter.

That is the entire algorithm.

The path is not pre-planned. Hub takes the best next step, observes the result, and decides the next step from there. This is how human problem-solving works. It is also what the industry calls a dynamic execution graph — most existing systems require a human to define the graph in advance; Hub constructs it itself.

When the task is complex enough that no single combination of inputs and outputs can solve it, Hub breaks it into smaller tasks and routes them in sequence or in parallel. The output of one becomes the input of the next. This continues until the original task is fulfilled.

---

## Marketplace

Hub is a real-time marketplace. Demand on one side, supply on the other.

**Demand** is every task arriving at Hub — a question, a build request, a scheduled job, a webhook event. The demand declares what it needs and what it can pay.

**Supply** is everything connected to the menu — every API, every model, every bot, every storage system, every owned key. Supply offers what it can do at what cost and what speed.

Most requests — eight or nine out of ten — are matched to supply the requester already owns. Their own OpenRouter key handles their own bot's inference. Direct path, zero friction. Hub's job there is simply to make the connection visible and execute it cleanly.

The remaining requests are where Hub earns its keep. The owner needs something they don't have. Hub finds it on the supply side and assembles a path the owner could never have designed themselves. They didn't know IPFS existed. They didn't know a specialized open-source model could do this for one cent. Hub knows, because the menu is live.

---

## Settlement

Internal accounting happens in dollar-denominated credits. Everyone understands dollars. No volatility. No conversion friction. You see exactly what each transaction costs.

Credits flow into the system in two ways: purchased with dollars, or purchased with LBS. Credits flow out in two ways: spent on routing through Hub, or paid out to providers as LBS.

LBS is not the operating currency. LBS is the ownership layer. The more the network processes, the more LBS is in circulation for a real reason. Providers connect because they get paid automatically. Owners use the system because delivery is guaranteed. Settlement is instant.

This is the same model Stripe and AWS use. Operate in dollars. Settle marketplace participants in something that gives them upside if the platform grows.

---

## First Experience

There are two entry points. Both are valid.

**Connect anything.** A new user plugs in one thing they already have — a Telegram bot, an OpenRouter API key, a 12-word seed phrase, a single endpoint. The moment they connect it, Hub shows them the full surface of what is now possible with exactly what they have. No setup wizard. No configuration. Just a live view of capability. Wizard then asks questions to refine what they actually want to build.

**Ask in plain language.** A user describes what they want. Hub proposes a solution and tells them what to connect to make it real.

Both paths converge on the same outcome: the user understands that connecting one more thing unlocks more than they expected, and Hub assembles the path.

---

## Growth Loop

Step one. Connect what you have. See the network of possibilities open up in real time.

Step two. Hub shows you what's now possible that you couldn't do before. The combinations reveal themselves. Wizard helps you extract the motivation underneath the request and turn it into something specific.

Step three. Hub introduces capabilities from the supply side that solve problems you didn't know you could solve cheaply. Permanent storage on IPFS for a dollar. Specialized inference for one cent. Capabilities that didn't exist last month and will exist next month.

The system compounds with every new connection. More connections mean more possible paths. More possible paths mean better answers at lower effort.

---

## What Hub Never Does

This is as architecturally critical as everything above. Hub never:

Reads the meaning of what it routes. Creates content. Stores data permanently — that is Buffer's role. Transforms data — that is the modules' role. Judges quality — that is the requester's role. Carries business logic — that is the application layer's role. Knows what happens after delivery.

Hub moves things from where they are to where they need to go, as reliably as possible, and forgets.

---

## What's Built Today

Hub 0.1 runs in production at hub.labs.co. The current implementation includes:

- Static hosting with git versioning per project
- Telegram bot runtime with sandboxed bot.js execution
- Per-project KV store (SQLite)
- HTTP API endpoints via routes.js — frontend, backend, and KV in one project
- Master coordinator bot @LabsHubBot
- Pass-based access control (SAP for server, PAP for project, AAP for agent)
- Three-server backup architecture (hub → beta + drafts.labs.vc)
- Public reference at hub.labs.co/docs

Vasilisa21robot is the first project using the full stack — frontend, bot, and HTTP API sharing the same KV.

---

## Roadmap

The architecture is final. Implementation continues in this order:

**1. Buffer as event-sourced state.** Today Buffer is per-project KV. The grand vision needs a shared layer where every module can publish and subscribe to changes across projects. This is the prerequisite for the marketplace.

**2. Capability tokens as first-class primitive.** Today access is via passes. The next step is scoped, time-limited, budget-bounded tokens that any module can mint and any other module can verify and consume.

**3. Live menu of supply.** Today connections are statically configured per project. The next step is a network-wide registry where every connection publishes its current state, cost, and latency, and Hub queries it at routing time.

**4. Settlement layer.** Today there is no inter-module accounting. The next step is dollar credits with LBS for input and output flow.

**5. Dynamic execution graph.** Today a project has fixed bot.js and routes.js. The next step is Hub assembling multi-hop pipelines automatically based on the live menu and the task at hand.

Each of these compounds the value of all previous work. None of them require breaking what is already deployed.

---

## The Bet

Hub is built on a single bet: that the long-term winner in AI infrastructure is not the model with the most parameters or the platform with the most features, but the routing layer that knows where everything is and can deliver any answer reliably by combining whatever is available right now.

The internet won not because TCP/IP was elegant, but because it was indifferent to what ran on top of it and obsessed with delivery. Hub follows the same playbook for the next era.

Build it small. Keep it dumb about content. Let the modules be smart. Settle marketplace participants automatically. Compound value with every connection.

That is Hub.

---

*Labs Hub Architecture · v0.1 · Drafted from first principles · April 30, 2026*
