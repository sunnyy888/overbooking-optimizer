// Tests for the overbooking core. Run: node test.mjs   (loads <script id="core"> from index.html)
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
const OB = new Function("module", html.match(/<script id="core">([\s\S]*?)<\/script>/)[1] + "; return OB;")({});
let pass = 0, fail = 0;
const check = (n, ok, d = "") => { ok ? pass++ : fail++; console.log(`${ok ? "PASS" : "FAIL"}  ${n}${d ? ": " + d : ""}`); };
const S = 150, CB = 300, CE = 180;

// 1. identical passengers: simulation matches the exact binomial expected cost at every level
{
  const fl = OB.synthFlights({ F: 20000, S, rate: 0.10, het: 0, noise: 0, within: 0, seed: 1 });
  const ev = OB.evaluate(fl, CB, CE);
  const worst = Math.max(...ev.levels.map(l => Math.abs(l.cost - OB.binomialCost(S, l.k, 0.10, CB, CE)) / l.se));
  check("simulated cost = exact binomial cost at k = 0..20 (identical passengers)", worst < 4, `max gap ${worst.toFixed(2)} SE`);
  const exact = ev.levels.map(l => OB.binomialCost(S, l.k, 0.10, CB, CE)), kExact = exact.indexOf(Math.min(...exact));
  check("simulated best level = exact best level", Math.abs(ev.best - kExact) <= 1, `sim +${ev.best}, exact +${kExact}`);
}
// 2. the newsvendor rule: keep adding tickets while P(the others fill the plane) < cE / (cE + cB)
{
  const q = 0.10, pmfGE = (n, s) => { let lp = n * Math.log(q), cdf = 0; for (let x = 0; x < s; x++) { cdf += Math.exp(lp); lp += Math.log((n - x) / (x + 1)) + Math.log((1 - q) / q); } return 1 - cdf; };
  let kRule = 0; while (kRule < 20 && pmfGE(S + kRule, S) < CE / (CE + CB)) kRule++;
  const exact = Array.from({ length: 21 }, (_, k) => OB.binomialCost(S, k, q, CB, CE)), kExact = exact.indexOf(Math.min(...exact));
  check("exact optimum obeys the critical-fractile rule", kRule === kExact, `rule +${kRule}, exact +${kExact} (fractile ${(CE / (CE + CB)).toFixed(3)})`);
  // more expensive bumps -> fewer extra tickets
  const k2 = (cb, ce) => { const c = Array.from({ length: 21 }, (_, k) => OB.binomialCost(S, k, q, cb, ce)); return c.indexOf(Math.min(...c)); };
  check("higher bump cost -> fewer extra tickets", k2(1000, 180) < k2(300, 180) && k2(300, 180) < k2(100, 180), `${k2(1000, 180)} < ${k2(300, 180)} < ${k2(100, 180)}`);
}
// 3. exact per-flight cost from scores: equals the binomial formula when scores are equal, and brute force on a tiny flight
{
  const eq = OB.costsFromScores(new Float64Array(S + 20).fill(0.1), S, CB, CE);
  const worst = Math.max(...Array.from({ length: 21 }, (_, k) => Math.abs(eq[k] - OB.binomialCost(S, k, 0.1, CB, CE))));
  check("equal scores: Poisson-binomial cost = binomial cost for every k", worst < 1e-6, `max diff ${worst.toExponential(1)}`);
  const s2 = 3, sc = [0.1, 0.3, 0.05, 0.5, 0.2, 0.15, 0.25, 0.4, 0.1, 0.3, 0.2, 0.6, 0.05, 0.1, 0.2, 0.3, 0.1, 0.2, 0.3, 0.1, 0.2, 0.15, 0.1];
  const dp = OB.costsFromScores(sc, s2, CB, CE);
  let ok = true;
  for (let k = 0; k <= 20; k++) {                       // enumerate all 2^(3+k) show patterns for small k
    if (s2 + k > 14) break;
    let c = 0; const m = s2 + k;
    for (let mask = 0; mask < 1 << m; mask++) { let pr = 1, shows = 0; for (let i = 0; i < m; i++) { const ns = (mask >> i) & 1; pr *= ns ? sc[i] : 1 - sc[i]; shows += 1 - ns; } c += pr * (shows > s2 ? CB * (shows - s2) : CE * (s2 - shows)); }
    if (Math.abs(c - dp[k]) > 1e-9) ok = false;
  }
  check("Poisson-binomial cost = brute-force enumeration (3 seats, up to 11 extra)", ok);
}
// 4. when do scores help? identical flights: no gain; very different flights: clear gain
{
  const same = OB.synthFlights({ F: 10000, S, rate: 0.10, het: 0, noise: 0, within: 0, seed: 7 }), e1 = OB.evaluate(same, CB, CE), s1 = OB.scorePolicy(same, e1, CB, CE);
  const gap1 = e1.levels[e1.best].cost - s1.cost;
  check("identical flights: scores add nothing (within noise)", Math.abs(gap1) < 3 * e1.levels[e1.best].se, `gap $${gap1.toFixed(1)}`);
  const diff = OB.synthFlights({ F: 10000, S, rate: 0.10, het: 1.0, noise: 0, seed: 7 }), e2 = OB.evaluate(diff, CB, CE), s2 = OB.scorePolicy(diff, e2, CB, CE);
  const save = e2.levels[e2.best].cost - s2.cost;
  check("very different flights: per-flight scores beat the best fixed level", save > 0.15 * e2.levels[e2.best].cost, `$${e2.levels[e2.best].cost.toFixed(0)} -> $${s2.cost.toFixed(0)} (${(100 * save / e2.levels[e2.best].cost).toFixed(1)}% saved)`);
  const noisy = OB.synthFlights({ F: 10000, S, rate: 0.10, het: 1.0, noise: 2, seed: 7 }), e3 = OB.evaluate(noisy, CB, CE), s3 = OB.scorePolicy(noisy, e3, CB, CE);
  check("noisier scores save less", e3.levels[e3.best].cost - s3.cost < save, `saved $${(e3.levels[e3.best].cost - s3.cost).toFixed(0)} vs $${save.toFixed(0)}`);
}
// 5. bookkeeping: bump risk grows with k, cost is never negative
{
  const ev = OB.evaluate(OB.synthFlights({ F: 3000, S, rate: 0.1, het: 0.6, noise: 0.5, seed: 9 }), CB, CE);
  check("P(bump) and average bumped rise with k", ev.levels.every((l, k) => !k || (l.pBump >= ev.levels[k - 1].pBump && l.bumped >= ev.levels[k - 1].bumped)));
}
// 6. speed: what the page does on every slider move
{
  const t = Date.now(), fl = OB.synthFlights({ F: 10000, S, rate: 0.1, het: 0.6, noise: 0.5, seed: 3 }), ev = OB.evaluate(fl, CB, CE); OB.scorePolicy(fl, ev, CB, CE);
  check("10,000 flights x 21 levels + score policy runs fast", Date.now() - t < 2500, `${Date.now() - t} ms`);
}
// 7. optional: the real HW4 scored bookings, if present locally (not committed)
{
  const f = `${homedir()}/larkspur_hw4/HW4-larkspur_noshow_scores.csv`;
  if (existsSync(f)) {
    const lines = readFileSync(f, "utf8").trim().split(/\r?\n/), head = lines.shift().split(","), is = head.indexOf("score"), iy = head.indexOf("no_show");
    const rows = lines.map(l => l.split(",")).map(c => ({ score: Math.min(0.999, Math.max(0.001, +c[is])), no_show: +c[iy] }));
    const fl = OB.bookingFlights({ F: 10000, S, rows, seed: 1 }), ev = OB.evaluate(fl, CB, CE), sp = OB.scorePolicy(fl, ev, CB, CE);
    console.log(`INFO  HW4 bookings: best fixed +${ev.best} at $${ev.levels[ev.best].cost.toFixed(0)}/flight; per-flight scores $${sp.cost.toFixed(0)}/flight`);
  } else console.log("SKIP  HW4 scored bookings not found locally");
}
console.log(`\n${pass}/${pass + fail} PASS`); process.exit(fail ? 1 : 0);
