# zhook-leak-check

What links a Robinhood Chain wallet to its trades? `zhook-leak-check` runs fixed, visible rules over public chain
data and returns each finding with a severity, the transactions that show it, and the fix.

It is the open version of the leak score and tracker check in the [Zerohook app](https://dapp.zerohook.trade).

- Public RPCs only. No API key, no indexer: logs are read in 1,000-block ranges from a public log RPC.
- Every finding cites transaction hashes you can open in the explorer.
- The test suite replays recorded RPC answers for real wallets, so it runs offline.

## Install

```sh
pnpm add @zerohooktrade/leak-check
# or run the CLI without installing
pnpm dlx @zerohooktrade/leak-check <address>
```

Node 20 or newer.

## CLI

```sh
zhook-leak-check 0x1CBe043703c0Aa3D3C5358bAa87912025B104E69
```

```
Leak check · zhook-leak-check/1
0x1CBe043703c0Aa3D3C5358bAa87912025B104E69 (plain wallet, 89 transactions sent)
Window: blocks 97,720,394–97,735,393 (~26 min)
Found: 0 high, 1 medium, 2 low · 4 clear · 0 not checked

[MED ] Reused address: 89 transactions sent
       Fix: Trade from a fresh address each time, so one trade can't be joined to the others.
[ ok ] No matching in and out amounts in the last ~26 min (blocks 97,720,394–97,735,393)
[LOW ] Funded by a busy wallet 0x88D2…51d3
       · First ETH from 0x88D25C861938a91AF4ad57aD964a8fCc6c6351d3: https://robinhoodchain.blockscout.com/tx/0x9651…975a
       Fix: Fund each trading wallet's gas from a source that isn't tied to your other wallets, not straight from your main wallet.
[ ok ] Nobody followed more than one of 2 trades
```

| Option                                      | Meaning                                                             |
| ------------------------------------------- | ------------------------------------------------------------------- |
| `--json`                                    | print the report as JSON                                            |
| `--with <address>`                          | also check another wallet, plus the links between them (repeatable) |
| `--blocks <n>`                              | window size in blocks (default 15,000, ~26 min; max 500,000)        |
| `--to-block <n>`                            | last block of the window (default: latest, minus ~5 s)              |
| `--no-funding`                              | skip the first-funding search                                       |
| `--no-tracker`                              | skip the tracker check                                              |
| `--rpc`, `--archive-rpc`, `--log-rpc <url>` | your own RPCs (each repeatable)                                     |
| `--span <n>`                                | blocks per `eth_getLogs` call (default 1,000)                       |
| `--verbose`                                 | print the details of clear findings too                             |

Exit codes: `0` nothing high, `1` at least one high-severity finding, `2` bad usage, `3` RPC failure. The exit code
makes it usable as a pre-trade gate in scripts.

## Rules

Each rule returns `status` (`found`, `clear`, `not-checked`), `severity` (`high`, `medium`, `low`, `none`),
`evidence` (transaction hashes with a note) and `fix`. A rule that lacks data says `not-checked`; it never guesses.

| Rule            | What it looks for                                                                                                                                      | Severity when found                                       |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------- |
| `address-reuse` | transactions sent from the address (nonce)                                                                                                             | low 1–19, medium 20–99, high 100+                         |
| `amount-match`  | an outgoing transfer that passes on an amount received earlier in the same token, within 10 bps (sells into the PoolManager or a router are ignored)   | high if any is exact, else medium                         |
| `round-amounts` | transfers with at most 2 significant digits (100, 2,500, 0.5), ignoring dust                                                                           | low 1–2, medium 3+                                        |
| `timing`        | an outgoing transfer 1–20 blocks (~2 s) after an incoming one                                                                                          | medium, high from 3                                       |
| `gas-funder`    | who sent the address its first ETH (see below)                                                                                                         | high personal wallet, medium contract, low busy wallet    |
| `shared-funder` | addresses that sent tokens here (not swap payouts) and also paid other addresses in the window                                                         | medium, low for contracts and senders with 50+ recipients |
| `tracker`       | after each recent swap output, who received the same token from the same source in the next 100 blocks; an address that did it after 2+ of your trades | medium, high for 2+ followers or 3+ trades followed       |
| `wallet-links`  | with `--with`: transfers between the wallets, a shared gas funder, a shared token sender                                                               | high for transfers or a shared funder, else medium        |

**Window.** Transfer-based rules read ERC-20 `Transfer` logs to and from the address over the window (15,000 blocks
by default, ~26 min at 0.105 s per block). Swap payouts are tokens sent by the v4 PoolManager, the Universal Router or
SwapRouter02.

**Gas funder without an indexer.** For a plain wallet (EOA), "has a balance or has sent a transaction" never turns
false again once true, so a binary search over block numbers on an archive RPC (about 27 steps) finds the first funded
block. The funding transaction is the one in that block sent to the address with value, or the only user transaction
in the block (ETH sent by a contract it called). The funder's sent-transaction count decides the severity: under 1,000
is treated as a personal wallet. Contracts and EIP-7702 accounts are not searched, because their balance can move
without their nonce.

## Library

```ts
import { leakCheck, leakCheckMany } from "@zerohooktrade/leak-check";

const report = await leakCheck("0x1CBe…4E69", { blocks: 30_000 });
report.summary; // { high: 0, medium: 1, low: 2, clear: 4, notChecked: 0 }
for (const f of report.findings) console.log(f.id, f.status, f.severity, f.evidence, f.fix);

const both = await leakCheckMany(["0x…a", "0x…b"]);
both.links; // the wallet-links finding
```

The rules are pure functions of a `WalletData` object (`addressReuse`, `amountMatch`, `roundAmounts`, `timing`,
`gasFunder`, `sharedFunder`, `tracker`, `walletLinks`, `runRules`), so you can run them on data from your own source.
Data helpers: `walletTransfers`, `getLogsChunked`, `findFunding`, `trackerCheck`. Transport: `httpRpc`, `makeRpcs`,
`recordRpc`, `replayRpc`.

### RPCs

Defaults need no key: `https://robinhood-rpc.publicnode.com` and `https://robinhood.drpc.org` for reads,
`https://robinhood.drpc.org` for past blocks, and `https://4663.rpc.thirdweb.com` for logs. publicnode refuses
`eth_getLogs` and dRPC's free tier caps ranges at about 100 blocks, so logs go to thirdweb's public endpoint, which
answers 1,000-block ranges. Ranges are read two at a time; a failing range is retried with backoff, then split in half
down to 100 blocks. If it still fails the window is marked incomplete and the affected rules say `not-checked`.

## Limits

- **Recent history only.** Transfer rules see the window, not the whole life of the address. A longer `--blocks` costs
  one log call per 1,000 blocks each way.
- **ERC-20 transfers only.** Native ETH moves are not in logs, so ETH payments are invisible to the amount, round and
  timing rules (the gas-funder rule reads balances instead).
- **No labels.** The tool does not know which address is an exchange or a bridge; it uses activity (nonce, recipients,
  contract code) as a proxy, and says so.
- **Tracker check:** one follower on a popular token is noise; only repeats are flagged. Only the 6 most recent trades
  are checked.
- **Shared funders:** the 8 most recent token senders are checked.

## Development

```sh
pnpm install
pnpm test        # offline: fixtures/*.json are replayed
pnpm lint && pnpm typecheck && pnpm build
RPC_URL=https://robinhood.drpc.org pnpm test:live            # optional: re-checks a recorded window on the chain
pnpm record <name> "<description>" <address> [<address> ...]  # records a new fixture
```

## Links

- Docs: https://docs.zerohook.trade
- App: https://dapp.zerohook.trade
- Website: https://zerohook.trade

## License

MIT © Zerohook
