#!/usr/bin/env node
/*
 * Regression harness for the product-recommendation demo.
 *
 * The demo ships as a single self-contained index.html. This test loads that file,
 * extracts the DOM-free engine (everything above the "UI" section), stubs the two
 * UI helpers the engine references (pick/esc) and a null `document`, then drives
 * real scripted conversations through handle() and asserts on the returned action
 * and the mutated session (state / cart / profile).
 *
 * Run:  node test.js        (exit code 0 = all pass, 1 = a failure)
 *
 * No dependencies. Deterministic (pick() is stubbed to take the first variant, and
 * the engine uses no Math.random outside pick()).
 */
const fs = require("fs");
const path = require("path");

/* ---- load + extract the engine ---- */
const html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
const script = html.split("<script>")[1].split("</script>")[0];
const uiMarker = "/* ===================== UI ===================== */";
const cut = script.indexOf(uiMarker);
if (cut < 0) { console.error("Could not find the UI section marker in index.html"); process.exit(2); }
const engine = script.slice(0, cut);

/* ---- stubs for the handful of UI helpers the engine text references ---- */
const prelude = `
  var document = { getElementById: function(){ return null; } };  // memoryOn()/clarifyBudget() guard on null -> defaults
  function pick(a){ return a[0]; }                                 // deterministic
  function esc(s){ return String(s); }
`;
const driver = `; globalThis.__engine = {
  handle: handle,
  reset: function(){ C = newConvo(); C.state = "ELICIT_NEED"; },
  setLang: function(l){ LANG = l; },
  C: function(){ return C; },
  score: function(t){ return scoreFunctions(normalize(t)); },
  ideal: function(c, fns){ return idealSweet(c, fns); },
  extract: function(t){ const c = blankConstraints(); extractInto(c, normalize(t)); return c; },
  partialMessage: function(s){ return partialMessage(s); },
  // set up a need whose constraints leave ZERO candidates (caffeine wanted + sweetness ceiling) and run the ranker;
  // the old relax loop spun forever on this — must now terminate with a valid result.
  noMatchTerminates: function(){
    C = newConvo();
    C.need = newNeed();
    C.need.functions = ["gift_novelty", "fruit_refreshment"];
    C.need.constraints.caffeine = true;   // nothing is caffeinated
    C.need.constraints.max_sweetness = 2; // and a ceiling → the two together used to loop
    C.need.rawUtterance = "";
    return doRank({ need: "", scores: {}, fns: [...C.need.functions], constraints: { ...C.need.constraints }, candidates: [], exclusions: [], decision: "", inv: "" });
  },
};`;
// eslint-disable-next-line no-eval
eval(prelude + engine + driver);
const E = globalThis.__engine;

/* ---- tiny assert framework ---- */
let pass = 0, fail = 0; const failures = [];
function ok(name, cond, extra) {
  if (cond) { pass++; }
  else { fail++; failures.push(name); console.log("  ✗ " + name + (extra !== undefined ? "  → " + JSON.stringify(extra) : "")); }
}
function section(t){ console.log("\n" + t); }

/* helper: one turn -> {kind, ...} (never renders; just the action + mutated session) */
function turn(msg){ return E.handle(msg); }
function state(){ return E.C().state; }
function cart(){ return E.C().cart; }
function cartHas(re){ return cart().some(i => re.test(i.name)); }
function rec(r){ return r && r.rec ? r.rec.name : null; }

/* ============================ ENGLISH ============================ */
E.setLang("en");

section("EN · rule engine handles recognized turns instantly (no LLM escalation)");
E.reset();
let r = turn("I just finished working out; nothing sweet");
ok("workout+not-sweet -> recommend", r.kind === "recommend", r.kind);
ok("  picks an electrolyte water", /Electrolyte/i.test(rec(r)), rec(r));
ok("  low sweetness (<=2)", r.rec && r.rec.sweetness <= 2, r.rec && r.rec.sweetness);
r = turn("make it two");
ok("  \"make it two\" -> added qty 2", r.kind === "added" && r.qty === 2, { kind: r.kind, qty: r.qty });
ok("  cart now holds the electrolyte", cartHas(/Electrolyte/i), cart().map(i => i.name));
r = turn("now I'd love some ice cream");
ok("  new need \"ice cream\" -> recommend Ice Cream", r.kind === "recommend" && /Ice Cream/i.test(rec(r)), rec(r));
r = turn("sure");
ok("  \"sure\" -> added", r.kind === "added", r.kind);
r = turn("that's all, check me out");
ok("  checkout -> kind checkout w/ 2 lines", r.kind === "checkout" && r.items.length === 2, r.items && r.items.length);
ok("  cart cleared after checkout", cart().length === 0, cart().length);

section("EN · preference memory carries across needs");
E.reset();
turn("I don't like sweet drinks");
ok("  \"don't like sweet\" persisted to profile", E.C().profile.notSweet === true, E.C().profile.notSweet);
r = turn("I'm thirsty");
ok("  later \"thirsty\" avoids sugary juice", r.kind === "recommend" && r.rec.sugar_level !== "high", { name: rec(r), sugar: r.rec && r.rec.sugar_level });

section("EN · references, options + ordinal, refine loop");
E.reset();
turn("I want a gift");
r = turn("the pink one instead");
ok("  \"the pink one instead\" -> pink item chosen", /pink/i.test(rec(r)) || cartHas(/pink/i), { rec: rec(r), cart: cart().map(i => i.name) });
E.reset();
turn("I want a gift");
r = turn("what else do you have");
ok("  \"what else\" -> options list", r.kind === "options" && r.options.length >= 1, r.kind);
r = turn("the second one");
ok("  \"the second one\" -> reselect 2nd option", r.kind === "recommend" && r.reselect === true, r.kind);
E.reset();
turn("something fruity");
r = turn("too sweet");
ok("  \"too sweet\" re-ranks to a less-sweet pick", r.kind === "recommend" && r.rec.sweetness <= 3, { name: rec(r), sw: r.rec && r.rec.sweetness });

section("EN · negation");
E.reset();
r = turn("no juice, just water");
ok("  \"no juice, just water\" -> a water, not a juice", r.kind === "recommend" && !/Juice/i.test(rec(r)), rec(r));

section("FIX · generic \"a drink\" stays on the rules and NEVER yields a gift/blind box (was: escalate → LLM picked a blind box)");
["something to drink", "i want a drink", "give me a drink", "can i get a beverage", "just want something to drink"].forEach(m => {
  E.reset();
  r = turn(m);
  ok("  \"" + m + "\" -> recommend (not escalate)", r.kind === "recommend", r.kind);
  ok("    -> a real drink, never a Blind Box / Collectible / Ice Cream", r.rec && !/Blind Box|Collectible|Ice Cream/i.test(rec(r)), rec(r));
});
// a bare, unqualified drink request should default to plain water (safest literal reading)
E.reset();
r = turn("something to drink");
ok("  bare \"something to drink\" -> plain water default", /Water/i.test(rec(r)) && !/Electrolyte/i.test(rec(r)), rec(r));
// a specific flavour/function in the same sentence still outranks the generic "drink" signal
E.reset();
r = turn("a fruity drink");
ok("  \"a fruity drink\" -> juice wins over the generic drink cue", /Juice/i.test(rec(r)), rec(r));
// "cold drink" is a chilled beverage, NOT the ice cream (the weak "cold"=dessert cue is dropped for a drink request)
E.reset();
r = turn("i just want a cold drink");
ok("  \"a cold drink\" -> a chilled water, not Ice Cream", /Water/i.test(rec(r)) && !/Ice Cream/i.test(rec(r)), rec(r));
// "give me a drink" — the incidental "give" (a gift cue) must not make it a blind box
E.reset();
r = turn("give me a drink");
ok("  \"give me a drink\" -> a drink, not a gift", !/Blind Box|Collectible/i.test(rec(r)), rec(r));
E.reset();
r = turn("a drink to recover after the gym");
ok("  \"a drink ... after the gym\" -> electrolyte wins", /Electrolyte/i.test(rec(r)), rec(r));
// "energy drink" must STILL hit the honest no-caffeine reply, not a plain-water rec
E.reset();
r = turn("do you have an energy drink");
ok("  \"energy drink\" -> honest no-caffeine reply (unchanged)", r.kind === "say" && /caffeinated/i.test(r.text), { kind: r.kind, text: (r.text || "").slice(0, 40) });

section("FIX · hunger/food maps to the only edible item (ice cream), not the LLM");
["i'm hungry", "something to eat", "i want food", "我饿了", "想吃东西"].forEach(m => {
  E.reset(); r = turn(m);
  ok("  \"" + m + "\" -> recommend Ice Cream (not escalate)", r.kind === "recommend" && /Ice Cream/i.test(rec(r)), { kind: r.kind, rec: rec(r) });
});

section("FIX · money / payment / logistics get an honest fixed reply, never an LLM-invented price");
[["how much is it", /demo|price/i], ["what's the price", /demo|price/i], ["do you take apple pay", /machine|pay/i]].forEach(([m, re]) => {
  E.reset(); r = turn(m);
  ok("  \"" + m + "\" -> a spoken honest reply (not escalate/rec)", r.kind === "say" && re.test(r.text), { kind: r.kind, text: (r.text || "").slice(0, 40) });
});
E.setLang("zh");
[["多少钱", /演示|价格/], ["怎么付款", /机器|付款/]].forEach(([m, re]) => {
  E.reset(); r = turn(m);
  ok("  中文 \"" + m + "\" -> honest zh reply", r.kind === "say" && re.test(r.text), { kind: r.kind, text: (r.text || "").slice(0, 30) });
});
E.setLang("en");

section("FIX · health/diet lean → the plain zero-sugar water, not an escalation");
["i'm diabetic", "something low calorie", "what's the healthiest option", "which has the least sugar", "哪个糖最少"].forEach(m => {
  E.reset(); r = turn(m);
  ok("  \"" + m + "\" -> recommend Evian water", r.kind === "recommend" && /Evian|Water/i.test(rec(r)) && r.rec.sugar_level !== "high", { kind: r.kind, rec: rec(r) });
});

section("FIX · we stock nothing hot/room-temp — say so honestly instead of handing over a chilled water");
["a hot drink", "something warm", "来个热的", "要常温的"].forEach(m => {
  E.reset(); r = turn(m);
  ok("  \"" + m + "\" -> honest 'chilled/frozen only' reply", r.kind === "say" && /(chilled|frozen|冷藏|冷冻)/i.test(r.text), { kind: r.kind, text: (r.text || "").slice(0, 30) });
});
// but weather talk like "hot day" is a hydration cue and must NOT trip the no-hot reply
E.reset(); r = turn("it's a hot day, something to drink");
ok("  \"hot day ... to drink\" -> a drink, not the no-hot notice", r.kind === "recommend", { kind: r.kind, rec: rec(r) });

section("FIX · a named product/brand/flavour is recommended directly, in BOTH languages (was: orange for 芒果, or a needless clarify)");
[["要芒果汁", /Mango/i], ["石榴电解质水", /Pomegranate/i], ["农夫山泉", /Nongfu|Juice/i], ["依云", /Evian/i],
 ["the mango one", /Mango/i], ["a pomegranate electrolyte", /Pomegranate/i], ["evian", /Evian/i]].forEach(([m, re]) => {
  E.reset(); r = turn(m);
  ok("  \"" + m + "\" -> recommend the named item", r.kind === "recommend" && re.test(rec(r)), { kind: r.kind, rec: rec(r) });
});

section("FIX · contraction & vague-mood openers stay on the rules (apostrophe-insensitive)");
E.reset(); ok("  \"i don't know what i want\" -> recommend", turn("i don't know what i want").kind === "recommend");
E.reset(); ok("  \"cheer me up\" -> recommend", turn("cheer me up").kind === "recommend");
E.reset(); ok("  \"what's most popular\" -> recommend", turn("what's most popular").kind === "recommend");
E.reset(); ok("  bare filler \"hmm\" -> gentle re-prompt (say, not escalate)", turn("hmm").kind === "say");
E.reset(); ok("  quantity-only \"give me three\" -> ask what (say, not escalate)", turn("give me three").kind === "say");

section("FIX · a NEW category voiced mid-recommendation switches needs (was: answered about the old pick)");
E.reset();
turn("i want juice");                                        // RECOMMEND, a juice on screen
r = turn("actually a gift instead");
ok("  \"actually a gift instead\" -> switch to a gift", r.kind === "recommend" && /Blind Box|Collectible/i.test(rec(r)), rec(r));
r = turn("the pink one");
ok("  then \"the pink one\" -> pink gift", /pink/i.test(rec(r)), rec(r));
r = turn("yes");
ok("  \"yes\" -> adds the pink gift", r.kind === "added" && /pink/i.test(r.product.name), r.product && r.product.name);
// a within-category tweak must NOT be misread as a category switch
E.reset();
turn("something fruity"); r = turn("the mango one");
ok("  \"the mango one\" (same category) -> still a juice reselect", r.kind === "recommend" && /Mango/i.test(rec(r)), rec(r));
// a product question must still answer, not switch
E.reset();
turn("i want juice"); r = turn("is it cold?");
ok("  \"is it cold?\" -> answers, keeps the juice (no switch)", r.kind === "say" && /chilled|frozen|room/i.test(r.text), r.text);

section("FIX · \"not sweet\" is never relaxed into sweet ice cream (explicit no-sugar honoured)");
["something not sweet, no caffeine, and cold", "a cold drink that isn't sweet", "not sweet and cold please"].forEach(m => {
  E.reset(); r = turn(m);
  ok("  \"" + m + "\" -> a low-sweetness pick, not Ice Cream", r.kind === "recommend" && r.rec.sweetness <= 2 && !/Ice Cream/i.test(rec(r)), { rec: rec(r), sw: r.rec && r.rec.sweetness });
});

section("FIX · \"surprise me\" recommends a drink/treat, not always a gift; an explicit gift still routes to gifts");
["surprise me", "you pick", "recommend something", "anything is fine"].forEach(m => {
  E.reset(); r = turn(m);
  ok("  \"" + m + "\" -> recommend a non-gift", r.kind === "recommend" && !/Blind Box|Collectible/i.test(rec(r)), rec(r));
});
["a surprise gift for a friend", "surprise me with a gift"].forEach(m => {
  E.reset(); r = turn(m);
  ok("  \"" + m + "\" -> an explicit gift still routes to a gift", r.kind === "recommend" && /Blind Box|Collectible/i.test(rec(r)), rec(r));
});

section("FIX · a named request stays exact (variety never overrides a specific ask)");
["要芒果汁", "the mango one", "a pomegranate electrolyte", "evian"].forEach(m => {
  const seen = new Set();
  for (let i = 0; i < 5; i++) { E.reset(); seen.add(rec(turn(m))); }   // pick() is deterministic-first in test; assert stability
  ok("  \"" + m + "\" -> same exact item every time", seen.size === 1, [...seen]);
});

section("FIX · typo tolerance: transpositions and doubled letters resolve (not escalate)");
[["im thirtsy", /Water/i], ["waterr please", /Water/i], ["gimme a giftt", /Blind Box|Collectible/i], ["a colllectible", /Blind Box|Collectible/i]].forEach(([m, re]) => {
  E.reset(); r = turn(m);
  ok("  \"" + m + "\" -> recognised (not escalate)", r.kind === "recommend" && re.test(rec(r)), { kind: r.kind, rec: rec(r) });
});
// the fuzzy matcher must NOT create collisions: "gold" is not "cold", "sweating" is not "sweet"
E.reset(); ok("  \"gold coin\" is NOT read as cold/a product", turn("gold coin").kind === "escalate");
E.reset(); r = turn("i am sweating"); ok("  \"sweating\" -> electrolyte recovery, not a sweet treat", r.kind === "recommend" && /Electrolyte/i.test(rec(r)), rec(r));

section("FEATURE · compound \"X and Y\" builds the whole basket (auto-advance on each add)");
E.reset();
r = turn("a water and an ice cream");
ok("  compound -> recommends the first item (water)", r.kind === "recommend" && /Water/i.test(rec(r)), rec(r));
r = turn("yes");
ok("  accept 1st -> added, and the NEXT item (ice cream) is chained", r.kind === "added" && r.next && r.next.kind === "recommend" && /Ice Cream/i.test(r.next.rec.name), r.next && r.next.rec && r.next.rec.name);
r = turn("yes");
ok("  accept 2nd -> both items now in the cart", cartHas(/Water/i) && cartHas(/Ice Cream/i), cart().map(i => i.name));
ok("  queue drained", E.C().queue.length === 0, E.C().queue);
// quantity is preserved per segment
E.reset();
turn("two waters and a juice"); r = turn("yes");
ok("  \"two waters\" segment keeps qty 2", r.kind === "added" && r.qty === 2, r.qty);
turn("yes");
ok("  ...and the juice is added after", cartHas(/Juice/i) && cart().find(i => /Water/i.test(i.name)).qty === 2, cart().map(i => i.name + "x" + i.qty));
// three items chain through
E.reset();
turn("a water, a juice, and an ice cream"); turn("yes"); turn("yes"); turn("yes");
ok("  \"A, B, and C\" -> all three added", cartHas(/Water/i) && cartHas(/Juice/i) && cartHas(/Ice Cream/i), cart().map(i => i.name));
// a shared modifier is NOT a compound
E.reset();
r = turn("something not sweet and cold");
ok("  \"not sweet and cold\" -> ONE low-sweet drink, no queue", r.kind === "recommend" && r.rec.sweetness <= 2 && E.C().queue.length === 0, { rec: rec(r), q: E.C().queue.length });
// a negated clause is not an item to add
E.reset();
r = turn("no juice, just water");
ok("  \"no juice, just water\" stays one need -> water (comma ≠ list)", r.kind === "recommend" && !/Juice/i.test(rec(r)) && E.C().queue.length === 0, rec(r));

/* ============================ FIXES ============================ */
section("FIX · checkout is honoured from ANY state (was a bug in RECOMMEND)");
E.reset();
turn("I want a gift"); turn("sure");                 // add a gift -> POST_ADD
turn("actually something fruity");                   // new need -> RECOMMEND, cart still holds the gift
ok("  precondition: mid-recommendation with a full cart", state() === "RECOMMEND" && cart().length === 1, { state: state(), cart: cart().length });
r = turn("check me out");                            // exactly what the always-enabled Checkout button sends
ok("  checkout while a recommendation is on screen -> checkout", r.kind === "checkout", r.kind);
ok("  cart cleared", cart().length === 0, cart().length);

section("FIX · strong checkout with an empty cart is graceful (not an LLM escalation)");
E.reset();
r = turn("check me out");
ok("  empty-cart checkout -> a spoken reply, not escalate", r.kind === "say", r.kind);

section("FIX · \"you pick\" after adding an item recommends (was a clarify fall-through)");
E.reset();
turn("I want water"); turn("sure");                  // POST_ADD
r = turn("you pick");
ok("  \"you pick\" in POST_ADD -> recommend", r.kind === "recommend", r.kind);

section("FIX · middle sweetness tier: \"a little sweet\" -> ceiling 3 (not wantSweet, not notSweet)");
let mid = E.extract("something a little sweet");
ok("  \"a little sweet\" -> max_sweetness 3", mid.max_sweetness === 3, mid.max_sweetness);
ok("  \"a little sweet\" -> not wantSweet, not notSweet", mid.wantSweet === false && mid.notSweet === false, { want: mid.wantSweet, not: mid.notSweet });
ok("  ideal sweetness for that tier == 3", E.ideal(mid, ["fruit_refreshment"]) === 3, E.ideal(mid, ["fruit_refreshment"]));
let hi = E.extract("make it very sweet");
ok("  \"very sweet\" -> wantSweet (unchanged)", hi.wantSweet === true && hi.max_sweetness === null, { want: hi.wantSweet, max: hi.max_sweetness });
let lo = E.extract("nothing sweet please");
ok("  \"nothing sweet\" -> notSweet + ceiling 2 (unchanged)", lo.notSweet === true && lo.max_sweetness === 2, { not: lo.notSweet, max: lo.max_sweetness });

section("FIX · POST_ADD: \"one more\" / \"N more\" re-adds the last item (was escalate)");
E.reset(); turn("I want water"); turn("sure");
r = turn("one more");
ok("  \"one more\" -> added again", r.kind === "added", r.kind);
ok("  cart line qty now 2", cart()[0] && cart()[0].qty === 2, cart().map(i => ({ n: i.name, q: i.qty })));
E.reset(); turn("I want water"); turn("sure");
turn("two more");
ok("  \"two more\" -> qty 3 total", cart()[0] && cart()[0].qty === 3, cart()[0] && cart()[0].qty);

section("FIX · POST_ADD: browse intents don't check out (was checkout + cleared cart)");
["something else", "what else do you have", "anything else"].forEach(m => {
  E.reset(); turn("I want water"); turn("sure");
  r = turn(m);
  ok("  \"" + m + "\" -> not checkout, cart intact", r.kind !== "checkout" && cart().length === 1, { kind: r.kind, cart: cart().length });
});
["no thanks", "no", "i'm done"].forEach(m => {
  E.reset(); turn("I want water"); turn("sure");
  r = turn(m);
  ok("  \"" + m + "\" -> checkout", r.kind === "checkout", r.kind);
});

section("FIX · RECOMMEND: product questions answered precisely, rec unchanged (was misread as constraints)");
function ask(q) { E.reset(); turn("something fruity"); const before = E.C().need.currentRec.id; const rr = turn(q); return { rr, unchanged: E.C().need.currentRec.id === before }; }
let a = ask("is it cold?");
ok("  \"is it cold?\" -> say, rec unchanged, mentions temperature", a.rr.kind === "say" && a.unchanged && /chilled|frozen|room temp/i.test(a.rr.text), { kind: a.rr.kind, unchanged: a.unchanged, text: a.rr.text });
a = ask("how much sugar does it have?");
ok("  \"how much sugar?\" -> mentions sugar", a.rr.kind === "say" && /sugar/i.test(a.rr.text), a.rr.text);
a = ask("does it have caffeine?");
ok("  \"caffeine?\" -> caffeine-free", a.rr.kind === "say" && /caffeine-free/i.test(a.rr.text), a.rr.text);
a = ask("how many calories?");
ok("  \"calories?\" -> kcal figure", a.rr.kind === "say" && /kcal|calorie/i.test(a.rr.text), a.rr.text);
a = ask("whats in it?");
ok("  \"what's in it?\" -> a real description", a.rr.kind === "say" && a.rr.text.length > 12, a.rr.text);

section("FIX · caffeine request is answered honestly (nothing caffeinated is stocked)");
["do you have anything with caffeine", "something with caffeine", "I need a pick-me-up with caffeine", "wake me up"].forEach(m => {
  E.reset();
  r = turn(m);
  ok("  \"" + m + "\" -> honest 'no caffeine' reply, not a random rec", r.kind === "say" && /caffeinated/i.test(r.text), { kind: r.kind, text: (r.text || "").slice(0, 40) });
});
{ E.reset(); const rr = turn("some water with no caffeine");   // a "no caffeine" request is satisfiable — must NOT hit the no-caffeine reply
  ok("  \"no caffeine\" is satisfiable -> recommend, not the no-caffeine notice", rr.kind === "recommend" && !/caffeinated/i.test(rr.text || ""), { kind: rr.kind }); }
ok("  YES_CAF sets caffeine=true constraint (future-proof)", E.extract("something with caffeine").caffeine === true, E.extract("something with caffeine").caffeine);

section("FIX · \"anything with X\" is no longer mistaken for \"surprise me\"");
{
  E.reset(); const r1 = turn("do you have anything with caffeine");
  ok("  routed to caffeine reply, not a surprise recommendation", r1.kind === "say" && /caffeinated/i.test(r1.text), r1.kind);
  E.reset(); ok("  \"surprise me\" still recommends", turn("surprise me").kind === "recommend", turn("surprise me").kind);
  E.reset(); ok("  \"anything is fine\" still recommends", turn("anything is fine").kind === "recommend", turn("anything is fine").kind);
}

/* ============================ ESCALATION ============================ */
section("EN · genuinely unrecognized input escalates to the LLM");
["I had a really rough day at the office", "do you accept credit cards", "tell me a joke"].forEach(m => {
  E.reset();
  ok("  \"" + m + "\" -> escalate", turn(m).kind === "escalate");
});

section("EN · small talk & recognized meta stay on the rules (no escalation)");
[["hi", "say"], ["thanks", "say"], ["what do you have", "say"], ["surprise me", "recommend"], ["not sweet", "say"]].forEach(([m, k]) => {
  E.reset();
  ok("  \"" + m + "\" -> " + k, turn(m).kind === k, turn(m).kind);
});

/* ============================ 中文 ============================ */
section("中文 · recognized turns stay on the rules; unrecognized escalates");
E.setLang("zh");
E.reset();
r = turn("刚健身完，不要太甜");   // just worked out, not too sweet
ok("  workout+not-sweet -> electrolyte", r.kind === "recommend" && /Electrolyte/i.test(rec(r)), rec(r));
E.reset();
r = turn("来两个");                                       // "make it two" (needs a current rec first)
E.reset();
turn("我想要水"); r = turn("来两瓶");     // I want water; two bottles
ok("  中文 quantity \"来两瓶\" -> added 2", r.kind === "added" && r.qty === 2, { kind: r.kind, qty: r.qty });
E.reset();
r = turn("想喝点东西");                                       // "want something to drink" -> a real drink, not a gift
ok("  中文 \"想喝点东西\" -> recommend a drink, not a gift", r.kind === "recommend" && !/Blind Box|Collectible|盲盒|收藏/i.test(rec(r)), rec(r));
E.reset();
r = turn("来点喝的");                                         // "get me a drink"
ok("  中文 \"来点喝的\" -> recommend (not escalate)", r.kind === "recommend", r.kind);
E.reset();
r = turn("结账");                                             // checkout, empty cart
ok("  中文 empty checkout -> graceful say", r.kind === "say", r.kind);
E.reset();
ok("  中文 unrecognized \"今天天气真好\" -> escalate", turn("今天天气真好").kind === "escalate");

section("LLM streaming: partialMessage extracts the message field as JSON streams in");
ok("  message field not started -> null", E.partialMessage('{"action":"recommend","sku":"evian') === null);
ok("  partial message rendered", E.partialMessage('{"action":"recommend","message":"If you just wa') === "If you just wa");
ok("  closing quote ends the message", E.partialMessage('{"action":"recommend","message":"Here you go.","sku":"x"}') === "Here you go.");
ok("  unescapes \\n mid-stream", E.partialMessage('{"message":"line1\\nline2') === "line1\nline2");

section("LLM streaming: simulated token stream renders progressively, then parses to an action");
{
  const finalJSON = '{"action":"recommend","sku":"evian_natural_mineral_water","message":"Evian is pure, zero-sugar water — shall I grab one?"}';
  const chunks = []; for (let i = 0; i < finalJSON.length; i += 7) chunks.push(finalJSON.slice(i, i + 7));  // arbitrary token-ish chunks
  let content = "", frames = [];
  for (const ch of chunks) { content += ch; const pm = E.partialMessage(content); if (pm) frames.push(pm); }
  const parsed = JSON.parse(content);
  ok("  accumulated content parses to the action", parsed.action === "recommend" && parsed.sku === "evian_natural_mineral_water", { action: parsed.action, sku: parsed.sku });
  ok("  message rendered progressively (frames grow)", frames.length > 3 && frames[0].length < frames[frames.length - 1].length, { n: frames.length, first: frames[0], last: frames[frames.length - 1] });
  ok("  final frame equals the complete message", frames[frames.length - 1] === parsed.message, frames[frames.length - 1]);
}

section("FIX · ranker relax always terminates (no infinite recursion / stack overflow)");
{
  let threw = false, r = null;
  try { r = E.noMatchTerminates(); } catch (e) { threw = true; }
  ok("  empty-candidate no-match terminates with a result", !threw && r && (r.kind === "recommend" || r.kind === "say"), threw ? "THREW/looped" : (r && r.kind));
}

section("FIX · streaming parser decodes \\uXXXX (no 'u4f60' garble in Chinese)");
ok("  \\u4f60\\u597d -> 你好", E.partialMessage('{"message":"\\u4f60\\u597d world') === "你好 world", E.partialMessage('{"message":"\\u4f60\\u597d world'));
ok("  incomplete \\u waits (no garbage)", E.partialMessage('{"message":"hi \\u4f') === "hi ", JSON.stringify(E.partialMessage('{"message":"hi \\u4f')));
ok("  raw Chinese streams through untouched", E.partialMessage('{"action":"reply","message":"你好，需要') === "你好，需要", E.partialMessage('{"action":"reply","message":"你好，需要'));

/* ============================ RESULT ============================ */
console.log("\n" + "=".repeat(52));
console.log("RESULT: " + pass + " passed, " + fail + " failed" + (fail ? " — " + failures.join("; ") : ""));
console.log("=".repeat(52));
process.exit(fail ? 1 : 0);
