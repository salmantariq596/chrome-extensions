# MEXC Quick Trade (v9.9.1)

## 9.9.1
- Sounds start only after your first click or key press on the MEXC page (Chrome's autoplay rule). Before that, alerts
  still show and pop up as notifications, and the red banner says "Click anywhere on the page to turn on alarm sounds".
  This removes Chrome's "The AudioContext was not allowed to start" warning.

## New in 9.9
- **"Use an activation price"** tick box in the Grid and One-direction editors (ticked by default).
  Ticked: the bot waits until the price touches the activation price, as before. Unticked: the activation field is hidden
  and **Start places all orders at once** ("Start … now"), each Limit or Trigger by the rule at the current price.
  Editing a waiting bot and unticking the box places its orders at once when you save.

## New in 9.8
- **One-direction tab** (replaces "Single order"): bots that trade only longs or only shorts.
  - **Long / Short**: the switch above the tabs. **▲ Up / ▼ Down**: which way the grids go from grid 1.
  - Activation price · Order price (= grid 1) · Grids · Gap · Amount · TP gap · SL gap (TP = grid ± TP gap, SL = grid ∓ SL gap).
    Any grid's amount, TP and SL can be changed in the table.
  - Example: Long, ▲ Up, activation 81,500, order price 81,600, gap 100, 3 grids → longs at 81,600 / 81,700 / 81,800 once the
    price touches 81,500.
  - Order type: Limit or Trigger (Market) by the same rule as the grid bot, decided again every time.
  - **Loop**: *Again at once* — after its TP or SL the same order (same price, amount, TP, SL) is placed again right away.
    *At a loop price* — after its TP or SL a grid waits until the market touches the loop price (e.g. 81,900), then its order
    is placed again.
  - + New bot, Edit while waiting, ↻ Refresh, Stop / Stop all, Resume, alerts: as in the grid bot. One-direction and grid bots
    can run together (up to 5 bots in total); bots can't share a grid price.
- **Grid bot**: back to **Activation price** and **Grid 1 price** typed separately (=Act copies the activation price).
- **Frozen page check** now watches MEXC's whole order book (all prices and quantities): no change for 60 s while the window
  is visible → critical alert "page looks frozen, press F5 and Resume".
- **Hedge tab removed.**

## New in 9.7
- **Edit a waiting bot:** a bot that still waits for its activation price has an **Edit** button. The form opens with its
  values (blue border, "Save changes"); change anything, save, and the same bot waits for the new activation price.
  ✕ closes the editor without changing the bot. Once a bot has activated (orders on MEXC) it can't be edited.
- **↻ Refresh** (top of the Grid tab, and on every activated bot): reads MEXC's Open Orders and Positions again and corrects
  the bots' records: orders that opened while unseen, orders that are waiting on MEXC, TPs/SLs that happened. It places and
  cancels nothing itself (a running bot then continues normally). If MEXC and the bots don't match, it pauses the running
  bots and says what is different. Orders on MEXC that no bot uses are listed so you can cancel them.
- **Alerts** tab, with a red count of unread alerts:
  - every event in one list (time, level, bot #): critical · warn · OK · info · note.
  - sounds by level: critical = alarm, warn/SL = low two tones, TP/OK = chime, fill = short beep.
  - **critical alerts** (bot paused, positions can't be read, no/frozen price, bot window gone, page refreshed while
    running, refresh found a difference) show a **red banner** on top of the panel (also when minimised) and repeat the alarm
    every 15 s until you press **Seen**. The QT button pulses red.
  - **Windows/Mac notifications** (Chrome asks nothing; allow notifications for Chrome in Windows/Mac settings if they don't
    show). Click one to bring the MEXC bot window to the front. Critical ones stay until you close them.
  - **Health watch:** no price for 20 s or the same price for 90 s, bot window in the background for 15 s, a waiting bot
    whose activation price is more than 1% away (once every 30 min per bot), positions unreadable for 10 s.
  - **Alert settings** (bottom of the Alerts tab): sounds on/off, which levels pop up as notifications, the "far away" %.
  - **Test alert** shows how a warning looks, sounds and pops up. The list is kept after a page refresh.

## New in 9.6: the bot keeps working (fixes from the 16 Oct log)
- **Prices from MEXC's own stream.** The page's trade/ticker messages (also on the testnet, also when the tab is in the
  background) give the bot every price low and high, so a quick dip to a grid is never missed. Before, the bot only saw the
  price at its own 0.3 s checks, which Chrome slows to once a second or once a minute in a background tab; a missed dip
  (e.g. bot #6, long 81,750) made the bot pause all bots when that order later hit its TP.
- **No pause when MEXC is slow to show an order.** The order shows "checking MEXC…"; the bot looks again a few seconds later
  and places it again only if it isn't there (up to 3 tries, then it pauses with a message). No duplicates.
- **Stop** no longer counts an order it just cancelled as opened (it happened when the order was too new to be in MEXC's list).
- Fewer log lines while you look at other bottom tabs.
- Still important: keep the MEXC bot window **visible** (its own Chrome window, not minimised). In a background tab the bot
  sees every price, but clicks on MEXC's form are slowed down by Chrome.

## New in 9.5: reading MEXC's position cards
- MEXC shows the L/S badge in the card's header row ("L BTCUSDT 20X Isolated Perpetual"), outside the part with Position and
  Unrealized PNL. 9.4 didn't find it, so with a long and a short open it couldn't read either side. Fixed.
- Positions of other coins (when "Hide Other Pairs" is off) are ignored.
- If the bot can't read the positions for ~10 s it now alarms loudly (sound, red message, "can't read positions!").
- **Resume** first looks at Open Orders: a waiting order that is gone counts as opened (e.g. a trigger that fired while the bot
  couldn't see it), then the positions are compared with MEXC.

## New in 9.4: no more lag
The bot used to search the whole MEXC page (order book, trades…) several times every 0.3 s: 40–110 ms each time on a busy page.
It now remembers where MEXC's tabs, order form and position cards are and only re-checks them: about 2 ms per check,
whatever the order book does. When several orders are placed at once, Limit orders go first, then Trigger orders
(fewer switches of MEXC's form).

## Install / update
1. Unzip. `chrome://extensions` → Developer mode → remove the old version → **Load unpacked** → `mexc-quick-long`.
2. Refresh the MEXC tab (F5). After every update: reload the extension and refresh the tab.
3. **Before updating from v8:** stop your v8 grids and let their positions close (or close them by hand). v8 grids are not carried over.

## MEXC setup (once)
- **Hedge mode**, Isolated, the leverage you want (set on MEXC — the panel no longer has a Leverage box). Quantity unit **USDT**.
  TP/SL entered by **Price**. Order confirmations off. English.
- **No open positions** (long or short) and no old orders when you start the grid bot.
- Bottom panel visible on the **Positions** tab (the bot reads the long and short position sizes there).

## Grid bot (new in 9.0) — "Grid" tab
| Setting | Meaning |
|---|---|
| ▲ Up / ▼ Down | grids go up or down from the activation price |
| Activation price | nothing is placed until the price **touches** it (from above or below) |
| Grid 1 price | the first grid level (new in 9.1: separate from the activation price; **=Act** copies the activation price) |
| Grids, Gap | number of grids (1–10) and the distance between them, counted from grid 1 |
| Long: Amount, TP gap, Stop loss | long at every grid: TP = grid + TP gap, SL = the price you type |
| Short: Amount, TP gap, Stop loss | short at every grid: TP = grid − TP gap, SL = the price you type |

The table under the settings shows every grid's long and short. **Any grid's long or short amount, TP and SL can be changed
there** (yellow = changed, "Reset all to defaults" undoes it). A TP or SL on the wrong side blocks Start.

Example: market 83,000 · activation 82,000 · grid 1 82,000 · Down · 3 grids · gap 200 · long TP gap 100, SL 80,000 · short TP gap 100, SL 83,000

| Grid | Long | Short |
|---|---|---|
| 82,000 | TP 82,100 · SL 80,000 | TP 81,900 · SL 83,000 |
| 81,800 | TP 81,900 · SL 80,000 | TP 81,700 · SL 83,000 |
| 81,600 | TP 81,700 · SL 80,000 | TP 81,500 · SL 83,000 |

**When the price touches the activation price (82,000)** the bot places a long AND a short at every grid (6 orders), TP and SL attached.

**Order type** — decided every time an order is placed, from the market price at that moment:
- Long: market at/above the grid → **Limit** · market below the grid → **Trigger** at the grid, price = **Market**
- Short: market at/below the grid → **Limit** · market above the grid → **Trigger** at the grid, price = **Market**

Example with a separate activation price: activation 82,500 · grid 1 82,000 · Down → grids 82,000 / 81,800 / 81,600.
When the price falls to 82,500: longs are Limit (market above the grids), shorts are Trigger (Market) at each grid.
The "Type" column in the editor shows the order type each order gets if placed at the activation price.

**Loop:** when a long or a short closes at its **TP or SL**, the same order (same grid price, amount, TP, SL) is placed again
right away (9.2: the bot checks the positions every 0.3 s), with the rule above. Example: long 81,200 closes at TP 81,250 →
a long Limit at 81,200 with TP 81,250 and the same SL is placed again. Example: long 81,800 hits TP 81,900 → market 81,900 is above 81,800 → Limit again. Short 81,800 hits SL 83,000 →
market 83,000 is above 81,800 → Trigger (Market) again. This repeats until you press Stop.

**Stop** (on every bot card, also when it is folded): cancels **all** of that bot's waiting orders — Limit and Trigger, long and
short, also an order it was placing at that moment. It reads Open Orders → Limit Order and → Trigger Order again until none
of its orders is left (3 tries; anything left is named so you can cancel it by hand). **Open positions are NOT closed** — they
keep their TP and SL on MEXC. The bot keeps tracking them (card shows "N open"). Stop before activation: nothing to cancel.

**Resume** on a stopped bot starts it again: positions are checked, and its orders that are not open are placed again with the
rule (a bot stopped before activation waits for the activation price again). **Stop all** stops every bot.

**Status per order** (click the card): not placed / waits for activation / Limit · waiting / Trigger · waiting / OPEN / placing… / to re-place.
**Mark closed** (paused or stopped bot) — for an open long/short you closed yourself on MEXC.

### Several grid bots (new in 9.3)
**+ New grid bot** opens the form while other bots run (up to 5 at once, same coin). Each bot has its own activation price, grids,
amounts, TP and SL. Two bots **can't use the same grid price** (MEXC lists orders by price, so the bot couldn't tell them apart) —
the form says which bot uses it. A new bot starts only when MEXC's positions match what the running bots expect, and not while a
bot is paused. When no bot is active the form opens by itself. The grid bots can't run together with the hedge bot (same
positions), and single orders are blocked while they have orders.

### Safety
MEXC keeps one long and one short position, so the bot explains every change of each position's size with the entries, TPs and
SLs the price actually reached (also several at once). Every 90 s it also compares its waiting orders with Open Orders → Limit
Order and → Trigger Order, and whenever the price touches a waiting order's grid while the position size stays the same, it
looks at those lists within a second or two (an order can open at the same moment as another one closes). Anything that doesn't add up (an order opened, closed or cancelled by hand, MEXC refusing an order)
**pauses the bot** with an explanation. Fix it on MEXC or use Mark closed, then **Resume** (both positions are checked first).
After a page refresh: a bot still waiting for activation stays armed; a running bot is paused → press Resume.

### Costs to keep in mind
- Trigger (Market) entries and every SL are taker orders (≈ 0.02% fee each at MEXC's futures taker rate — check your rate).
- In a choppy market around a grid, the loop can re-enter after every SL: each SL costs amount × (grid − SL) ÷ grid plus fees
  (20 USDT long 81,800 → SL 80,000 ≈ −0.44 USDT).
- PnL in the panel is an estimate before fees; MEXC's history is the real number.

## Hedge bot (new in 7.0) — "Hedge" tab
Example: market 82,500 · Entry 82,000 · SL gap 50 · Amount 1,000 USDT per side.

| | Long | Short |
|---|---|---|
| Opens | when Last price reaches 82,000, at market | when Last price reaches 82,000, at market |
| SL (attached) | 81,950 | 82,050 |
| TP | add by hand on MEXC after it opens (keep the SL!) | same |
| After its SL hits | same trigger order again: at 82,000 open long at market, SL 81,950 | same for the short |
| Closed by TP or by hand | not re-opened; press **Re-arm long** to place it again | **Re-arm short** |

- Both entries are MEXC **Trigger orders** (trigger = entry, price = Market), so they open together at the entry
  whichever side of it the market is on.
- Repeats until **Stop hedge**, which cancels the bot's waiting trigger orders (open positions keep their SL).
- **Apply new values** (while running): new entry / SL gap / amount for all future re-entries; waiting trigger orders
  are replaced right away. Open positions keep their current SL.
- If a position shows **no SL** on MEXC (e.g. adding the TP removed it), the panel alarms and tells you which SL to set.
- If the trigger fires and the SL hits between two checks, the bot notices it from the price and the Trigger Order
  list and re-places the trigger.
- Needs **Hedge mode** on MEXC, no open positions at start, and cannot run together with grids (same positions).
  Single orders are blocked while it runs. Uses the leverage set on MEXC.
- **Test trigger form** fills MEXC's Trigger form (trigger, Market, amount, SL) without ordering and checks that the
  Trigger Order list can be read.
- Cost reminder: each SL ≈ amount × gap ÷ entry (1,000 × 50 ÷ 82,000 ≈ 0.61 USDT) plus taker fees on the market
  entry and market SL (≈ 0.40 USDT at 0.02%). Choppy prices around the entry can trigger many SLs in a row.

## New in 6.2
- **Resize the panel:** drag its right edge (width), bottom edge (height) or the grip in the bottom-right corner (both).
  The size is remembered. Double-click the corner grip to go back to the default size. Content scrolls if the panel is short.

## Bot window and viewer windows (new in 6.0)
- The MEXC window where you press **Start grid** (or **Resume**) becomes the **BOT WINDOW** (shown in the panel header).
  It manages the bots. Keep it open and **visible** (half screen or a second monitor) and don't use its bottom panel.
- Any other MEXC window is a **viewer**: it shows the grids' live status, can send **Stop grid** to the bot window,
  and can place single orders (on a side without a running grid). It never trades for the grids.
- If the bot window closes, crashes or sleeps, every viewer raises an alarm within ~8 s
  ("no bot!"). TP/SL on MEXC stay active. Press **Resume** in a viewer to take over; it becomes the bot window.
- Refreshing the bot window keeps it the bot window (press Resume after the refresh).

## Fast spikes (new in 6.0)
If the price goes through a waiting level's entry **and** its TP between two checks (or while you look at another
tab), the position size may not change at all. The bot notices this from the price, checks Open Orders → Limit Order
for about a second, and if the order is gone it counts the TP and re-places the level (and places the next level).
If the order is still there (price touched it without a fill), nothing changes.

## Recording MEXC data (diagnostic for the next version)
**Record MEXC data** listens, read-only, to the order/position data the MEXC page already receives and saves it to a
file in Downloads when you press **Stop & save**. Tokens, signatures, user/account ids, emails and phones are removed;
order ids are replaced by id1, id2…. Nothing is sent anywhere.

## Looking at other bottom tabs while a grid runs
The grid reads the position size on the **Positions** tab. If you click another bottom tab yourself
(Open Orders, Position History…), the grid leaves it there for **60 seconds**, then returns to Positions.
The panel shows a countdown and a **Back now** button. TP/SL stay active on MEXC the whole time;
a fill or TP that happens meanwhile is handled as soon as Positions is back (only the re-placement is delayed).

## Buttons
- **Test order forms** (Grid tab) — fills MEXC's Limit form and Trigger (Market) form with amount, TP and SL without ordering,
  and checks that Open Orders (Limit + Trigger) and both positions can be read. Run it before the first Start.
- **Check page**, **Copy log** — for troubleshooting.
