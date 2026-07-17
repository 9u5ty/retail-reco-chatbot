# ENGINE.md — Recommendation Engine + Conversation State Machine

Retail-robot product-recommendation chatbot demo. This document is the implementation
spec. Everything here is designed to be transcribed into vanilla JavaScript with no
external NLP libraries: real word lists, real numeric thresholds, deterministic formulas.

---

## 0. Data Model (recap of what the engine consumes)

Each catalog product object:

```js
{
  sku:        "EW-WGJ-001",         // unique id
  name:       "White Grape & Jasmine Electrolyte Water",
  category:   "electrolyte_water",  // free-text merchandising category
  function_tags: ["rehydration_electrolytes", "hydration"], // FIXED vocab, 1+ tags
  sweetness:  1,                    // integer 0..5
  sugar_level:"low",                // "none" | "low" | "medium" | "high"
  served:     "chilled",            // "ambient" | "chilled" | "frozen"
  caffeine:   false,                // bool
  in_stock:   true,                 // bool
  qty:        24,                   // integer, units on shelf
  keywords:   ["electrolyte","recovery","post-workout","sweat","light","refresh"], // shopper cue words
  blurb:      "Light mineral water with a whisper of jasmine..."
}
```

FIXED function_tags vocabulary (the ONLY 5 allowed values):

```
hydration
rehydration_electrolytes
fruit_refreshment
treat_dessert
gift_novelty
```

Everything below (inference, ranking, prompts) is scoped to exactly these 5 tags.

### Normalization (run once on every raw user utterance before any matching)

```js
function normalize(text) {
  return text
    .toLowerCase()
    .replace(/[’‘]/g, "'")            // curly → straight apostrophe
    .replace(/[^a-z0-9'\s-]/g, " ")   // strip punctuation except ' and -
    .replace(/\s+/g, " ")
    .trim();
}
// Match cues with word boundaries on this normalized string, e.g.
// new RegExp(`\\b${cue.replace(/[-/\\^$*+?.()|[\]{}]/g,'\\$&')}\\b`).test(norm)
```

All cue lists below are matched case-insensitively against the normalized string.

---

## PART 1 — STATE MACHINE

### 1.1 States

| State | Purpose |
|-------|---------|
| `GREETING` | Bot opens the conversation, invites a need. |
| `ELICIT_NEED` | Waiting for / capturing the shopper's free-text need. |
| `INFER` | Internal (no user turn): run function inference + constraint extraction on the utterance. |
| `CLARIFY` | Ask ONE clarifying question, wait for the answer, fold it back into state. |
| `FILTER_AND_RANK` | Internal (no user turn): build candidate set and score it. |
| `RECOMMEND` | Present the single best item + a purchase-intent question; wait for the user. |
| `FULFILL` | Terminal-ish: acknowledge the order ("Alright, please wait a moment."). |
| `NO_MATCH` | Internal fallback when candidate set is empty; routes to CLARIFY or a graceful apology. |
| `END` | Conversation closed (user says goodbye / declines everything after cap). |

`INFER`, `FILTER_AND_RANK`, and `NO_MATCH` are *computational* states — they consume no
user turn; the machine passes straight through them and emits the next user-facing state.

### 1.2 Session context object (mutable, carried across states)

```js
session = {
  state: "GREETING",
  rawUtterance: "",
  functionScores: {},        // {rehydration_electrolytes: 3, hydration: 1, ...}
  inferredFunctions: [],      // sorted tags above threshold
  constraints: {              // extracted filters (see Part 3)
    max_sweetness: null,      // number | null
    prefer_sugar: [],         // subset of ["none","low","medium","high"]
    served_in: [],            // subset of ["ambient","chilled","frozen"]
    caffeine: null,           // true | false | null
  },
  candidates: [],             // ranked array after FILTER_AND_RANK
  currentRec: null,           // the SKU being offered
  offeredSkus: [],            // SKUs already declined (never re-offer)
  clarifyCount: 0,            // how many clarifying questions asked this need
  turnCount: 0,
}
```

### 1.3 Transitions (trigger → target, with exact conditions)

| # | From | Trigger / Condition | To | Side effects |
|---|------|--------------------|----|--------------|
| T1 | `GREETING` | Session starts (bot's first render) | `ELICIT_NEED` | Emit greeting line. |
| T2 | `ELICIT_NEED` | User submits any non-empty message | `INFER` | `rawUtterance = normalize(msg)`; `turnCount++`. |
| T3 | `ELICIT_NEED` | User message matches **exit** cues (`bye`, `never mind`, `nothing`, `that's all`) | `END` | Emit sign-off. |
| T4 | `INFER` | `inferredFunctions.length === 0` (no tag scored ≥ threshold) **AND** `clarifyCount < 2` | `CLARIFY` | Pick "identify need" question (Q1). |
| T5 | `INFER` | `inferredFunctions.length >= 2` and the top-2 tags are within `TIE_MARGIN` (=1) of each other (ambiguous category) **AND** `clarifyCount < 2` | `CLARIFY` | Pick disambiguation question by category pair (Q2/Q3/Q4). |
| T6 | `INFER` | A **decisive constraint is unknown** but likely relevant (see 1.4) **AND** `clarifyCount < 2` | `CLARIFY` | Pick the matching constraint question (Q5/Q6). |
| T7 | `INFER` | Exactly one dominant function OR `clarifyCount >= 2` (clarify budget spent) | `FILTER_AND_RANK` | — |
| T8 | `CLARIFY` | User answers | `INFER` | `clarifyCount++`; merge answer into `rawUtterance` (append normalized answer) and re-run inference + extraction on the *combined* text. |
| T9 | `CLARIFY` | User answers with an **accept**-type phrase to a yes/no product question already implying a rec | `FILTER_AND_RANK` | (rare shortcut; safe to route through INFER instead.) |
| T10 | `FILTER_AND_RANK` | `candidates.length >= 1` | `RECOMMEND` | `currentRec = candidates[0]`. |
| T11 | `FILTER_AND_RANK` | `candidates.length === 0` | `NO_MATCH` | — |
| T12 | `NO_MATCH` | `clarifyCount < 2` AND at least one constraint could be relaxed | `CLARIFY` | Ask the relax/confirm question (Q7); on next INFER, drop the softest constraint (see 1.5). |
| T13 | `NO_MATCH` | `clarifyCount >= 2` OR nothing left to relax | `END` | Emit graceful "couldn't find a match" apology. |
| T14 | `RECOMMEND` | User utterance matches **ACCEPT** set (Part 6) | `FULFILL` | Mark order for `currentRec`. |
| T15 | `RECOMMEND` | User utterance matches **DECLINE/REFINE** set AND carries a **new constraint** (e.g. "too sweet", "no caffeine") | `FILTER_AND_RANK` | Push `currentRec.sku` to `offeredSkus`; merge new constraint; re-rank excluding offered SKUs. |
| T16 | `RECOMMEND` | User utterance matches plain **DECLINE** with no new constraint ("no", "something else") | `FILTER_AND_RANK` | Push `currentRec.sku` to `offeredSkus`; re-rank; if candidates now empty → `NO_MATCH`. |
| T17 | `RECOMMEND` | User asks a question / adds info that is neither accept nor decline ("what's in it?", "is it cold?") = **ASK_MORE** | `CLARIFY` (answer mode) | Answer from product fields, then re-offer same `currentRec` (do NOT increment clarifyCount, do NOT change rec). |
| T18 | `RECOMMEND` | User utterance matches **exit** cues | `END` | Sign-off. |
| T19 | `FULFILL` | Order acknowledged | `END` (or `ELICIT_NEED` if "anything else?") | Emit "Alright, please wait a moment."; optionally offer to continue. |

> The RECOMMEND ↔ FILTER_AND_RANK cycle (T15/T16 → T10) is the **refinement loop**. It
> repeats until ACCEPT (T14), exhausted candidates (T16→T11→T13), or exit (T18). The loop
> "must continue asking/refining until the user accepts" — this is enforced by always
> re-entering RECOMMEND with the next-best candidate after any non-accepting turn.

### 1.4 "Decisive constraint unknown" rule (for T6)

A constraint is *decisive & unknown* when the inferred function is one where that attribute
strongly splits the catalog, and the user gave no cue for it:

- Function `fruit_refreshment` or `treat_dessert` chosen, but **no sweetness cue** given →
  ask sweetness (Q5). (These categories span sweetness 2–5; it's the biggest differentiator.)
- Function `hydration`/`rehydration_electrolytes` chosen, but **no temperature cue** and the
  matching SKUs split across `ambient` vs `chilled` → ask temperature (Q6).
- Only fire T6 if it would actually change the top candidate (i.e. the current candidate set
  contains items on both sides of the split). Otherwise skip to FILTER_AND_RANK.

### 1.5 Constraint-relaxation order (for T12, softest dropped first)

```
1. served_in        (temperature is a preference, easiest to give up)
2. prefer_sugar     (sugar preference, secondary to hard max_sweetness)
3. max_sweetness    (relax by +1, e.g. <=2 becomes <=3)
4. caffeine         (only relax if user re-confirms — Q7)
```
Never relax `in_stock` or the inferred `function` — those are hard.

### 1.6 Reference walkthrough (must reproduce)

```
GREETING  → "Hi! What are you in the mood for today?"
ELICIT_NEED
  user: "I just finished working out and need a quick recovery; I don't want anything sweet."
INFER
  functionScores: {rehydration_electrolytes: 3 (post-workout, recovery, working out),
                   hydration: 1}
  inferredFunctions: ["rehydration_electrolytes"]  // single dominant → T7
  constraints: {max_sweetness: 2, prefer_sugar: ["none","low"]}  // "not sweet"
FILTER_AND_RANK
  candidates = electrolyte SKUs, in_stock, sweetness<=2 → White Grape & Jasmine wins
RECOMMEND
  → "For a post-workout recovery that isn't sweet, I'd go with the White Grape & Jasmine
     electrolyte water — light, replenishing, barely any sweetness. Shall I get one for you?"
  user: "sure"                                   // ACCEPT (T14)
FULFILL
  → "Alright, please wait a moment."
END
```

---

## PART 2 — NEED → FUNCTION INFERENCE RULES

Each user utterance is scored against all 5 tags. A cue hit adds its weight to that tag's
score. **Strong cues = 2 points, supporting cues = 1 point.** After scoring:

```js
THRESHOLD = 2;                 // a tag is "inferred" only if score >= 2
TIE_MARGIN = 1;                // top-2 within this → ambiguous (Part 1 T5)
inferredFunctions = tags with score >= THRESHOLD, sorted desc by score.
```

### 2.1 `rehydration_electrolytes`  (post-workout / recovery / sweat)

Strong (2 pts): `post-workout`, `post workout`, `after my workout`, `after the gym`,
`worked out`, `working out`, `just finished working out`, `gym`, `exercise`, `exercised`,
`sweat`, `sweaty`, `sweating`, `electrolyte`, `electrolytes`, `recovery`, `recover`,
`rehydrate`, `rehydration`, `dehydrated`, `cramp`, `cramping`, `sports drink`, `hangover`.

Supporting (1 pt): `run`, `ran`, `running`, `jog`, `jogging`, `hike`, `hiking`, `training`,
`marathon`, `spin class`, `yoga`, `tired`, `wiped out`, `replenish`, `salts`, `minerals`.

### 2.2 `hydration`  (thirsty / plain water / refresh)

Strong (2 pts): `thirsty`, `parched`, `hydrate`, `hydration`, `plain water`, `just water`,
`still water`, `sparkling water`, `drink of water`, `dry mouth`, `quench`.

Supporting (1 pt): `water`, `refresh`, `refreshing`, `something light`, `light`, `nothing
heavy`, `simple`, `clean`, `no calories`, `zero calorie`, `hot day`, `it's hot`.

### 2.3 `fruit_refreshment`  (fruity / juice / sweet-ish refreshment)

Strong (2 pts): `juice`, `fruity`, `fruit`, `smoothie`, `orange juice`, `apple juice`,
`fruit drink`, `something fruity`, `berry`, `berries`, `mango`, `peach`, `citrus`,
`lemonade`, `tropical`.

Supporting (1 pt): `sweet`, `refreshment`, `refreshing`, `tangy`, `zesty`, `pulp`,
`vitamin c`, `breakfast`, `brunch`.

### 2.4 `treat_dessert`  (dessert / cold / ice cream / treat)

Strong (2 pts): `dessert`, `ice cream`, `ice-cream`, `gelato`, `sorbet`, `popsicle`,
`treat`, `sweet treat`, `indulge`, `indulgent`, `craving something sweet`, `sundae`,
`frozen`, `milkshake`, `pudding`, `cake`.

Supporting (1 pt): `cold`, `icy`, `chilled dessert`, `after dinner`, `snack`, `guilty
pleasure`, `reward myself`, `chocolate`, `creamy`, `rich`, `decadent`.

### 2.5 `gift_novelty`  (gift / collectible / fun / surprise / present)

Strong (2 pts): `gift`, `present`, `for a friend`, `for my`, `collectible`, `collector`,
`limited edition`, `novelty`, `surprise`, `souvenir`, `party favor`, `party favour`,
`stocking stuffer`, `birthday`, `giftable`.

Supporting (1 pt): `fun`, `cute`, `quirky`, `cool packaging`, `instagram`, `unique`,
`special`, `fancy`, `share with`, `bring to a party`.

### 2.6 Disambiguation notes

- `sweet` alone is a *supporting* cue for both `fruit_refreshment` and `treat_dessert`; it
  never crosses THRESHOLD by itself → forces CLARIFY (good).
- `cold`/`chilled`/`icy` are handled as **constraints** (Part 3) AND as supporting cues for
  `treat_dessert`; they add temperature filter regardless of the chosen function.
- `refresh`/`refreshing` intentionally nudges both `hydration` and `fruit_refreshment` (1 pt
  each) — if that's the only cue, the two tie → CLARIFY Q3.

---

## PART 3 — CONSTRAINT EXTRACTION

Scan the (combined) normalized utterance for each phrase group; set the corresponding
filter. Later user turns override/add to earlier ones.

### 3.1 Sweetness / sugar

| Trigger phrases | Effect |
|---|---|
| `not sweet`, `no sugar`, `sugar free`, `sugar-free`, `unsweetened`, `less sweet`, `not too sweet`, `nothing sweet`, `don't want anything sweet`, `low sugar`, `light on sugar`, `not sugary` | `max_sweetness = 2`; `prefer_sugar = ["none","low"]` |
| `a little sweet`, `slightly sweet`, `mildly sweet`, `not too sweet but` | `max_sweetness = 3`; `prefer_sugar = ["low","medium"]` |
| `sweet`, `sweeter`, `very sweet`, `super sweet`, `extra sweet`, `sugary`, `love sweet` | `min_sweetness = 3` (soft — used as ranking boost, see Part 4) |
| `too sweet` (as a decline, Part 6) | tighten current `max_sweetness` by −1 (min 0) and re-rank |

### 3.2 Temperature / served

| Trigger phrases | Effect |
|---|---|
| `cold`, `chilled`, `icy`, `ice cold`, `ice-cold`, `cool`, `refrigerated` | `served_in = ["chilled","frozen"]` |
| `frozen`, `ice cream`, `gelato`, `sorbet`, `popsicle`, `slushie`, `frozen treat` | `served_in = ["frozen"]` |
| `room temperature`, `room temp`, `not cold`, `warm`, `ambient`, `not chilled` | `served_in = ["ambient"]` |
| (no cue) | `served_in = []` → no filter (all temps eligible) |

### 3.3 Caffeine

| Trigger phrases | Effect |
|---|---|
| `no caffeine`, `caffeine free`, `caffeine-free`, `decaf`, `without caffeine`, `no coffee`, `can't have caffeine`, `avoid caffeine` | `caffeine = false` |
| `caffeine`, `caffeinated`, `energy`, `pick me up`, `pick-me-up`, `keep me awake`, `energized` | `caffeine = true` |
| (no cue) | `caffeine = null` → no filter |

### 3.4 Stock / quantity (always applied)

- Hard filter: `in_stock === true` and `qty > 0` on every candidate, always.
- Multi-buy cues (`a few`, `two`, `some for the group`, `pack`, `for everyone`): note desired
  count `wantQty`; if `qty < wantQty`, keep the item but flag low stock in the reply.

### 3.5 Constraint application (the filter step)

```js
function passesConstraints(p, c) {
  if (!p.in_stock || p.qty <= 0) return false;
  if (c.max_sweetness != null && p.sweetness > c.max_sweetness) return false;
  if (c.served_in.length && !c.served_in.includes(p.served)) return false;
  if (c.caffeine != null && p.caffeine !== c.caffeine) return false;
  // prefer_sugar and min_sweetness are SOFT — not filtered here, applied in ranking.
  return true;
}
```

---

## PART 4 — RANKING

Candidate set = products where `function_tags ∩ inferredFunctions ≠ ∅`
**AND** `passesConstraints(p, constraints)` **AND** `sku ∉ offeredSkus`.

For each candidate compute a deterministic score. Higher = better.

### 4.1 Score formula

```
score(p) =
    3 * functionMatch(p)        // # of inferred functions this product's tags cover (0..N)
  + 2 * keywordOverlap(p)       // # of user cue words also in p.keywords[] (capped at 4)
  + sweetnessFit(p)             // 0..3, how well sweetness matches the sweetness intent
  + sugarPref(p)                // +1 if p.sugar_level ∈ prefer_sugar, else 0
  + tempPref(p)                 // +1 if served_in empty (neutral) handled elsewhere; +1 if p.served == first served_in pref
  + stockConfidence(p)          // qty>=10 → +1 ; qty>=3 → +0.5 ; else 0
```

Component definitions:

```js
// functionMatch: reward covering the dominant + secondary inferred function
functionMatch(p) = count(inferredFunctions ∩ p.function_tags);   // 0,1,2...

// keywordOverlap: tokenized user cues vs product keywords, capped
keywordOverlap(p) = min(4, |userCueTokens ∩ p.keywords|);

// sweetnessFit: distance from the "ideal" sweetness implied by constraints
//   ideal = if max_sweetness set → target the top allowed band (max_sweetness),
//           else if min_sweetness set → target 5,
//           else → 3 (neutral).
//   fit = 3 - min(3, |p.sweetness - ideal|)      // 3 = perfect, down to 0
sweetnessFit(p) = 3 - min(3, Math.abs(p.sweetness - idealSweetness));
```

`tempPref`: if `served_in` non-empty, `+1` when `p.served === served_in[0]`, `+0.5` when
`p.served` is in `served_in` but not the first; else `0`. If `served_in` empty, `0` for all.

### 4.2 Worked example (reference case)

Constraints: `max_sweetness=2`, `prefer_sugar=["none","low"]`, function
`rehydration_electrolytes`. idealSweetness = 2.

White Grape & Jasmine electrolyte water (sweetness 1, sugar low, chilled, qty 24,
keywords include `post-workout`,`sweat`,`recovery`,`electrolyte`):
```
functionMatch = 1 (rehydration_electrolytes)      → 3*1  = 3.0
keywordOverlap = min(4, {post-workout, recovery, sweat, electrolyte}) = 4 → 2*4 = 8.0
sweetnessFit  = 3 - min(3,|1-2|) = 3 - 1 = 2                → 2.0
sugarPref     = low ∈ {none,low}                            → 1.0
tempPref      = served_in empty (user gave no temp cue)     → 0.0
stockConfidence = qty 24 >= 10                              → 1.0
TOTAL = 16.0  ← selected as candidates[0]
```
Any high-sugar juice is excluded up front by `sweetness > 2` filter, so it never competes.

### 4.3 Tie-break (deterministic, applied in order until broken)

1. Higher `functionMatch` (covers more inferred functions).
2. Higher `keywordOverlap`.
3. Closer `sweetnessFit` (higher).
4. Higher `qty` (push what we have most of).
5. Lower `sweetness` when user asked "not sweet", else higher `sweetness` when user asked
   "sweet"; neutral → higher `sweetness`.
6. Lexicographically smallest `sku` (absolute deterministic final fallback).

```js
candidates.sort((a,b) =>
     score(b) - score(a)
  || functionMatch(b) - functionMatch(a)
  || keywordOverlap(b) - keywordOverlap(a)
  || sweetnessFit(b) - sweetnessFit(a)
  || b.qty - a.qty
  || sweetDirection(a,b)                       // per rule 5
  || (a.sku < b.sku ? -1 : 1)
);
currentRec = candidates[0];
```

---

## PART 5 — CLARIFYING-QUESTION POLICY & BANK

### 5.1 When to ask (fire order; ask at most one per turn)

1. **Zero tags** — `inferredFunctions.length === 0` → ask Q1 (identify need). (T4)
2. **Competing categories** — top-2 tags within `TIE_MARGIN` → ask the pair-specific
   disambiguator Q2/Q3/Q4. (T5)
3. **Missing decisive constraint** — function known but a splitting attribute is unknown
   (rule 1.4) → ask Q5 (sweetness) or Q6 (temperature). (T6)
4. **No match after filtering** — candidate set empty → ask Q7 (relax a constraint). (T12)

### 5.2 How many

- Ask **one question at a time**; wait for the answer; fold it in; re-infer.
- **Hard cap: 2 clarifying questions per need** (`clarifyCount >= 2` → stop clarifying and
  recommend the best available anyway, T7). ASK_MORE product questions (T17) do NOT count
  against this cap.
- The refinement loop after RECOMMEND is separate and uncapped — it continues until accept
  or candidates exhausted.

### 5.3 Question bank

| ID | Question | Resolves | Fires when |
|----|----------|----------|-----------|
| Q1 | "Happy to help! Are you after something to **hydrate**, a **fruity** pick-me-up, a **sweet treat**, or a **gift**?" | Zero-tag → picks a function bucket | T4 |
| Q2 | "Got it — would you like a **plain, replenishing water**, or something **fruity and flavored**?" | `hydration`/`rehydration_electrolytes` vs `fruit_refreshment` | T5 (that pair) |
| Q3 | "Are you looking to **quench your thirst**, or more in the mood for a **dessert-style treat**?" | `hydration`/`fruit_refreshment` vs `treat_dessert` | T5 (that pair) |
| Q4 | "Is this **for yourself**, or a **gift / something fun to give**?" | any function vs `gift_novelty` | T5 (that pair) |
| Q5 | "How sweet do you like it — **not sweet**, **a little**, or **nice and sweet**?" | Unknown sweetness (sets max_sweetness) | T6 |
| Q6 | "Would you prefer it **chilled/cold** or **room temperature**?" | Unknown served (sets served_in) | T6 |
| Q7 | "I don't have an exact match in stock — should I look for something **slightly sweeter** / **not as cold** / **with caffeine**?" (fill blank with the softest relaxable constraint) | Empty candidate set → permission to relax | T12 |

Answer parsing for clarifying questions reuses Parts 2 & 3 cue lists on the answer text
(e.g. Q1 answer "fruity" → +2 `fruit_refreshment`; Q5 answer "not sweet" → `max_sweetness=2`).

---

## PART 6 — ACCEPTANCE / DECLINE DETECTION

Matched against the normalized RECOMMEND-turn utterance. Check ACCEPT first, then
DECLINE-with-constraint, then plain DECLINE, then ASK_MORE, else treat as ASK_MORE.

### 6.1 ACCEPT (→ FULFILL, T14)

```
sure, yes, yeah, yep, yup, ok, okay, k, sounds good, sounds great, that works,
i'll take it, ill take it, i will take it, take it, get one, get me one, grab one,
go ahead, do it, please do, yes please, let's do it, lets do it, perfect, great,
that one, i'll have it, ill have it, add it, buy it, deal, why not
```
Regex-anchored where short (e.g. `\bk\b`, `\bok\b`) to avoid matching inside other words.

### 6.2 DECLINE / REFINE with a NEW CONSTRAINT (→ FILTER_AND_RANK, T15)

Detected when a decline OR any Part-3 constraint phrase appears with corrective intent:

```
too sweet            → tighten max_sweetness −1
not sweet enough     → raise min_sweetness (prefer sweeter)
too cold             → served_in = ["ambient"]
not cold enough / warmer than i want → served_in = ["chilled","frozen"]
has caffeine / no caffeine           → caffeine = false
too sugary           → prefer_sugar = ["none","low"], max_sweetness −1
something fruitier   → +2 fruit_refreshment
something lighter    → +1 hydration, lower max_sweetness
i'd prefer / rather have / instead / can i get <X>  → re-infer on <X>
```
Always: `offeredSkus.push(currentRec.sku)` then re-rank.

### 6.3 PLAIN DECLINE (no new info) (→ FILTER_AND_RANK next-best, T16)

```
no, nope, nah, not that, not really, something else, anything else, other options,
what else, a different one, don't like it, dont like it, not for me, pass, next,
show me another, not that one, meh
```
`offeredSkus.push(currentRec.sku)`; offer `candidates[next]`. If none left → NO_MATCH.

### 6.4 ASK_MORE (question about the product) (→ CLARIFY answer-mode, T17)

Trigger: utterance contains `?` or starts with `what`, `how`, `is it`, `does it`, `can it`,
`where`, `which`, `why`, `whats`, `what's`, `how much`, `price`, `cost`, `ingredients`,
`sugar`, `calories`, `caffeine in it`. Answer from product fields (blurb, sugar_level,
sweetness, served, caffeine, qty/price), then **re-offer the same rec** ("Still happy to
grab it for you?"). Does not change `currentRec`, does not spend clarify budget.

### 6.5 Priority resolution

```
1. exit cues              → END
2. ACCEPT                 → FULFILL
3. DECLINE+constraint     → FILTER_AND_RANK (merge constraint)
4. plain DECLINE          → FILTER_AND_RANK (next best)
5. ASK_MORE               → answer + re-offer
6. (fallback) unrecognized→ treat as ASK_MORE: "Would you like this one, or shall I find an alternative?"
```

---

## PART 7 — LLM PROMPT TEMPLATES

These replace the rule engine with a reasoning model while keeping the same state machine.
The model returns a JSON action the state machine consumes (7c). The catalog is injected as
context each turn (or via retrieval).

### 7a. SYSTEM prompt

```
You are the in-store recommendation brain for a retail vending robot. You help one shopper
at a time pick a SINGLE best drink or treat from the store's catalog and, once they agree,
confirm the order.

CATALOG VOCABULARY — every product is tagged with one or more function_tags from this FIXED
set; never invent others:
  • hydration               — plain water / thirst-quenching / light & clean
  • rehydration_electrolytes— post-workout, sweat, recovery, cramps, electrolytes
  • fruit_refreshment       — juice, fruity, flavored refreshment
  • treat_dessert           — dessert, ice cream, frozen/indulgent sweet treats
  • gift_novelty            — gifts, collectibles, novelty/surprise items
Each product also has: name, category, sweetness (0–5), sugar_level (none/low/medium/high),
served (ambient/chilled/frozen), caffeine (true/false), in_stock, qty, keywords[], blurb.

YOUR JOB:
1. Read the shopper's need and map it to ONE dominant function_tag (plus a secondary if
   clearly present).
2. Extract hard constraints: sweetness ceiling ("not sweet" ⇒ sweetness ≤ 2 & sugar none/low),
   temperature ("cold/chilled" ⇒ served chilled or frozen), caffeine ("no caffeine" ⇒ false).
3. Recommend exactly ONE in-stock product that best fits function ∩ constraints. Prefer items
   whose keywords overlap the shopper's words and whose sweetness fits their intent.
4. If the need is unclear (no function matches, or two categories tie, or a decisive
   constraint like sweetness/temperature is unknown and would change the pick), ask ONE short
   clarifying question instead of guessing. Ask at most TWO clarifying questions total, then
   recommend the best available anyway.
5. After a recommendation, if the shopper accepts, confirm the order. If they decline or add a
   new constraint ("too sweet", "something fruitier"), pick the next best item that honors the
   new constraint and never re-offer a rejected item. Keep going until they accept or nothing
   is left.

RULES:
- Only ever recommend items where in_stock = true and qty > 0.
- Recommend ONE item at a time, never a list.
- Be concise, warm, and specific; name the product and give a one-line reason tied to their
  need. End a recommendation with a purchase-intent question ("Shall I get one for you?").
- Never fabricate products, tags, or attributes not present in the provided catalog.
- Always respond by emitting ONE JSON action from the schema (see OUTPUT FORMAT). Put any
  reasoning in the "scratchpad" field, never in prose to the user.
```

### 7b. Structured reasoning / scratchpad format

The model fills this before choosing an action. It mirrors the reference example
(need → function → candidates → exclusions → inventory check).

```
SCRATCHPAD:
  need:        <verbatim paraphrase of what the shopper wants>
  function:    <one of the 5 tags; + secondary tag if clear; or "AMBIGUOUS: tagA vs tagB">
  constraints: {max_sweetness: <n|none>, prefer_sugar: [...], served_in: [...],
                caffeine: <true|false|none>}
  candidates:  [<sku> (<name>, sweetness <n>, sugar <lvl>, served <x>, qty <n>), ...]
               # only in-stock items matching function ∩ constraints
  exclusions:  [<sku> — <why removed: e.g. "sweetness 4 > ceiling 2", "out of stock",
                "already declined">]
  inventory_check: <chosen sku> qty <n> — OK / LOW / OUT
  decision:    <ask_clarifying | recommend | confirm_order> because <one line>
```

Reference instantiation:

```
SCRATCHPAD:
  need:        just finished a workout, wants quick recovery, nothing sweet
  function:    rehydration_electrolytes
  constraints: {max_sweetness: 2, prefer_sugar: [none, low], served_in: [], caffeine: none}
  candidates:  [EW-WGJ-001 (White Grape & Jasmine Electrolyte Water, sweetness 1, sugar low,
                served chilled, qty 24)]
  exclusions:  [JU-ORG-004 — sweetness 4 > ceiling 2; sugar high]
  inventory_check: EW-WGJ-001 qty 24 — OK
  decision:    recommend because best electrolyte fit and well under the sweetness ceiling
```

### 7c. JSON action-output schema (what the state machine consumes)

The model MUST output exactly one JSON object, no prose outside it:

```json
{
  "scratchpad": "string — the reasoning block from 7b (kept out of the user-facing text)",
  "action": "ask_clarifying | recommend | confirm_order",
  "ask_clarifying": {
    "question": "string — one short question shown to the shopper",
    "resolves": "function | sweetness | temperature | caffeine | audience"
  },
  "recommend": {
    "sku": "string — must exist in catalog and be in_stock",
    "reason": "string — one-line, shopper-facing justification tied to their need",
    "message": "string — full shopper-facing line ending in a purchase-intent question"
  },
  "confirm_order": {
    "sku": "string — the SKU the shopper accepted",
    "message": "string — e.g. 'Alright, please wait a moment.'"
  }
}
```

Consumption rules for the state machine:

- `action === "ask_clarifying"` → render `ask_clarifying.question`; stay in CLARIFY;
  increment `clarifyCount`.
- `action === "recommend"` → validate `recommend.sku` is in catalog, in_stock, qty>0, and
  not in `offeredSkus`; if invalid, re-prompt the model; else set `currentRec`, render
  `recommend.message`, enter RECOMMEND.
- `action === "confirm_order"` → render `confirm_order.message`, enter FULFILL.
- Only ONE of `ask_clarifying` / `recommend` / `confirm_order` is populated per response
  (the one named by `action`); the others may be omitted.

Turn payload sent to the model each turn:

```json
{
  "shopper_message": "<latest user utterance>",
  "history": [ {"role":"user|assistant","content":"..."} ],
  "offered_skus": ["<already-declined skus>"],
  "clarify_count": 0,
  "catalog": [ { /* product objects, in_stock ones */ } ]
}
```

### 7d. Fine-tuning knobs (prompt-level dials)

| Knob | Range / values | Effect | Default for this demo |
|------|----------------|--------|-----------------------|
| `tone` | `warm_concise` \| `playful` \| `neutral_efficient` | Wording of user-facing lines; length of reason string | `warm_concise` |
| `clarify_aggressiveness` | `0.0`–`1.0` (or `low`/`med`/`high`) | Higher = ask clarifying questions more readily (raises effective ambiguity sensitivity, lowers the confidence needed to fire a question); lower = commit to a recommendation sooner | `0.35` (lean toward recommending — matches the reference, which recommends immediately) |
| `max_clarify` | integer | Hard cap on clarifying questions before recommending anyway | `2` |
| `upsell` | `on` \| `off` | When `on`, after `confirm_order` append a single complementary suggestion ("Want a snack to go with it?"); when `off`, stop at the confirmation | `off` (reference ends at "please wait a moment.") |
| `recommend_count` | `1` (locked) | Items offered per turn; keep at 1 for this robot | `1` |
| `stock_bias` | `0.0`–`1.0` | How strongly to prefer high-qty items (maps to `stockConfidence` weight) | `0.3` |
| `sweetness_strictness` | `soft` \| `hard` | Whether a sweetness cue is a hard filter or a strong ranking preference | `hard` for "not sweet" (safety), `soft` for "sweet" |

Wire-up: `tone`, `clarify_aggressiveness`, `upsell`, `stock_bias` are inserted as a short
"BEHAVIOR SETTINGS" block appended to the SYSTEM prompt, e.g.:

```
BEHAVIOR SETTINGS: tone=warm_concise; clarify_aggressiveness=0.35 (prefer to recommend when a
reasonable single pick exists); max_clarify=2; upsell=off; recommend_count=1; stock_bias=0.3;
sweetness_strictness: treat "not sweet" as a hard ceiling.
```

---

## Appendix A — End-to-end control flow (pseudocode)

```js
function step(session, userMsg) {
  const msg = normalize(userMsg);
  switch (session.state) {
    case "GREETING":
      return emit("Hi! What are you in the mood for today?"), goto("ELICIT_NEED");

    case "ELICIT_NEED":
      if (isExit(msg)) return goto("END"), signoff();
      session.rawUtterance = msg; session.turnCount++;
      return infer(session);          // → INFER logic below

    case "CLARIFY":
      // fold answer back in, re-infer on combined text
      session.rawUtterance += " " + msg;
      return infer(session);

    case "RECOMMEND":
      if (isExit(msg))            return goto("END"), signoff();
      if (isAccept(msg))          return fulfill(session);            // T14
      if (isDeclineWithC(msg))    return applyNewConstraint(session, msg), rank(session); // T15
      if (isPlainDecline(msg))    return session.offeredSkus.push(session.currentRec.sku), rank(session); // T16
      if (isAskMore(msg))         return answerProductQ(session, msg); // T17, re-offer same rec
      return reoffer(session);     // fallback
  }
}

function infer(session) {                       // INFER state
  scoreFunctions(session);                       // Part 2
  extractConstraints(session);                   // Part 3
  const fns = session.inferredFunctions;
  if (fns.length === 0 && session.clarifyCount < 2)          return clarify(session, "Q1"); // T4
  if (isAmbiguousPair(session) && session.clarifyCount < 2)  return clarify(session, pairQ(session)); // T5
  if (needsConstraintQ(session) && session.clarifyCount < 2) return clarify(session, constraintQ(session)); // T6
  return rank(session);                          // T7
}

function rank(session) {                         // FILTER_AND_RANK state
  const cands = catalog
    .filter(p => intersects(p.function_tags, session.inferredFunctions))
    .filter(p => passesConstraints(p, session.constraints))
    .filter(p => !session.offeredSkus.includes(p.sku));
  cands.sort(byScoreThenTieBreak);               // Part 4
  session.candidates = cands;
  if (cands.length === 0) return noMatch(session); // T11 → NO_MATCH
  session.currentRec = cands[0];                 // T10
  return recommend(session);                      // → RECOMMEND
}
```

## Appendix B — Minimal seed catalog (for the demo to run against)

```js
const catalog = [
  { sku:"EW-WGJ-001", name:"White Grape & Jasmine Electrolyte Water",
    category:"electrolyte_water", function_tags:["rehydration_electrolytes","hydration"],
    sweetness:1, sugar_level:"low", served:"chilled", caffeine:false, in_stock:true, qty:24,
    keywords:["electrolyte","recovery","post-workout","sweat","light","refresh","rehydrate"],
    blurb:"Light mineral water with a whisper of jasmine and grape — replenishes without the sugar." },
  { sku:"SW-PLN-002", name:"Still Spring Water",
    category:"water", function_tags:["hydration"],
    sweetness:0, sugar_level:"none", served:"ambient", caffeine:false, in_stock:true, qty:40,
    keywords:["water","plain","thirsty","hydrate","simple","clean"],
    blurb:"Just clean, crisp spring water." },
  { sku:"JU-ORG-004", name:"Sunny Orange Pulp Juice",
    category:"juice", function_tags:["fruit_refreshment"],
    sweetness:4, sugar_level:"high", served:"chilled", caffeine:false, in_stock:true, qty:18,
    keywords:["juice","orange","fruity","citrus","sweet","vitamin c","breakfast"],
    blurb:"Freshly squeezed orange juice with real pulp." },
  { sku:"IC-VAN-006", name:"Vanilla Bean Ice Cream Cup",
    category:"ice_cream", function_tags:["treat_dessert"],
    sweetness:5, sugar_level:"high", served:"frozen", caffeine:false, in_stock:true, qty:12,
    keywords:["ice cream","dessert","treat","frozen","creamy","sweet","indulge"],
    blurb:"Rich frozen vanilla bean custard." },
  { sku:"GF-BOT-009", name:"Collector's Astronaut Fizz Bottle",
    category:"novelty_soda", function_tags:["gift_novelty","fruit_refreshment"],
    sweetness:3, sugar_level:"medium", served:"ambient", caffeine:false, in_stock:true, qty:8,
    keywords:["gift","collectible","novelty","fun","surprise","present","cool packaging"],
    blurb:"Limited-edition space-themed soda in a keepsake bottle — a fun little gift." }
];
```

---

*End of ENGINE.md*
