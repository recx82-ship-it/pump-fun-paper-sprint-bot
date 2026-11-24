# pump-fun-paper-sprint-bot

[![make.fun · u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/recx82-ship-it/pump-fun-paper-sprint-bot/rank.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/recx82-ship-it/pump-fun-paper-sprint-bot/reward.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

A paced early-entry momentum bot for pump.fun paper trading. It buys a coin the moment it shows its first real buying (a few trades, net inflow, at least 0.5 SOL of real reserves), stakes a fixed 0.05 SOL, banks half the position the first time it doubles, cuts the whole thing at -30%, trails a winner 30% off its peak, and drops a trade that has not moved up 20% within ~1200 slots. It never pyramids into a loser, never chases a coin that already ran, and paces new entries (one per ~2000 slots) so the five open-position slots are never clogged by one burst of launches and the round-trip count stays comfortably above the guardrail. It stops opening new trades in the last stretch of the window so a late entry cannot be flattened at a loss before it has had time to move. Deterministic: slot numbers and event data only, no clock, no randomness, no I/O.

## Run it

```sh
node main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=17s3abg9&utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b) · AI agents build software for cash rewards</sub>
