// Runs INSIDE the game's UI context, like engine-write.mjs: CdpSession.call serialises it with
// toString(), so it must stay self-contained.

// One game-state action, verified. Reads the value the action should change, sends it, then re-reads
// until the change is observed or the wait ends. Every request goes out as the local player with the
// target named in it; every player id is resolved with Players.get first, because an invalid id passed
// to some engine calls crashes the game natively.
// settleMs is the least wait for writes the engine applies seconds after the call (a yield grant lands
// about 3 s later, watched 2026-09-25).
export async function performCheat({ op, args, waitMs, settleMs = 6000 }) {
  // Grouped declarations keep the bundle inside the statement limit; each name is a small helper.
  const G = /** @type {any} */ (globalThis),
    safe = (f, d = /** @type {any} */ (null)) => { try { return f(); } catch { return d; } },
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    local = GameContext.localPlayerID,
    pid = args.player,
    P = () => Players.get(pid),
    yt = (name) => safe(() => G.YieldTypes[name]),
    fn = (f) => typeof safe(f) === "function",
    onMap = (x, y) => !!safe(() => GameplayMap.isValidLocation({ x, y }), false),
    refuse = (reason) => ({ verdict: "REFUSED", reason, sent: false }),
    sign = (a, b, want) => typeof a === "number" && typeof b === "number" && Math.sign(b - a) === Math.sign(want),
    queueEmpty = (c) => c.empty === true || c.item === null || c.item === undefined || c.item === -1,
    send = (kind, req) => Game.PlayerOperations.sendRequest(local, kind, req),
    plain = (v) => JSON.parse(JSON.stringify(v)),
    canStartOf = (kind, req) => () => safe(() => plain(Game.PlayerOperations.canStart(local, kind, req, false)));

  // Readers: each returns plain data, so before and after compare as JSON.
  const V = {
    pool: (name) => safe(() => ({
      YIELD_GOLD: () => P().Treasury.goldBalance,
      YIELD_DIPLOMACY: () => P().DiplomacyTreasury.diplomacyBalance,
      YIELD_HAPPINESS: () => P().Stats.getLifetimeYield(yt("YIELD_HAPPINESS")),
    })[name]()),
    node: (tree) => {
      const sub = safe(() => (tree === "tech" ? P().Techs : P().Culture));
      const type = safe(() => (tree === "tech" ? sub.getTreeType() : sub.getActiveTree()));
      const t = safe(() => Game.ProgressionTrees.getTree(pid, type));
      const node = t && t.activeNodeIndex >= 0 ? safe(() => t.nodes[t.activeNodeIndex].nodeType) : null;
      if (node === null || node === undefined) return { node: null };
      const data = safe(() => Game.ProgressionTrees.getNode(pid, node)) ?? {};
      return {
        node, name: safe(() => GameInfo.ProgressionTreeNodes.lookup(node).ProgressionTreeNodeType),
        progress: data.progress ?? null, depth: data.depthUnlocked ?? null, cost: safe(() => sub.getNodeCost(node)),
      };
    },
    unit: (cid) => {
      const u = safe(() => Units.get(cid));
      if (!u) return null;
      return {
        owner: cid.owner, id: cid.id, type: safe(() => GameInfo.Units.lookup(u.type).UnitType),
        x: safe(() => u.location.x), y: safe(() => u.location.y),
        damage: safe(() => u.Health.damage), maxDamage: safe(() => u.Health.maxDamage),
        xp: safe(() => u.Experience.experiencePoints), promotions: safe(() => u.Experience.getTotalPromotionsEarned),
        moves: safe(() => u.Movement.movementMovesRemaining), maxMoves: safe(() => u.Movement.maxMoves),
      };
    },
    city: (cid) => {
      const c = safe(() => Cities.get(cid));
      if (!c) return null;
      const q = safe(() => c.BuildQueue) ?? {};
      return {
        owner: cid.owner, id: cid.id, population: safe(() => c.population), pending: safe(() => c.pendingPopulation),
        item: safe(() => q.currentProductionTypeHash), progress: safe(() => q.currentBuildProgress),
        required: safe(() => q.currentBuildProgressRequired), empty: safe(() => q.isEmpty),
      };
    },
  };

  // Finders: a unit or city by its owner and local id, or by plot.
  const F = {
    ownUnits: () => safe(() => P().Units.getUnitIds(), []) || [],
    unit: () => (Number.isInteger(args.unit)
      ? F.ownUnits().find((c) => c.id === args.unit)
      : (safe(() => MapUnits.getUnits(args.x, args.y), []) || []).find((c) => c.owner === pid)) ?? null,
    city: () => {
      if (Number.isInteger(args.city)) {
        return (safe(() => P().Cities.getCities(), []) || []).map((c) => c.id).find((c) => c?.id === args.city) ?? null;
      }
      return F.centre(args.x, args.y);
    },
    // getCity answers for every plot a city owns, so only its centre counts.
    centre: (x, y) => {
      const c = safe(() => MapCities.getCity(x, y));
      const l = c ? safe(() => Cities.get(c).location) : null;
      return l && l.x === x && l.y === y ? c : null;
    },
  };
  const withUnit = (make) => {
    const cid = F.unit();
    if (!cid) {
      return Number.isInteger(args.unit) ? `player ${pid} has no unit ${args.unit}` : `player ${pid} has no unit at (${args.x}, ${args.y})`;
    }
    const u = V.unit(cid);
    return u ? make(cid, u, () => V.unit(cid)) : "the unit could not be read";
  }, withCity = (make) => {
    const cid = F.city();
    if (!cid) {
      return Number.isInteger(args.city) ? `player ${pid} has no city ${args.city}` : `no settlement centre at (${args.x}, ${args.y})`;
    }
    if (cid.owner !== pid) return `that settlement belongs to player ${cid.owner}, not ${pid}`;
    const c = V.city(cid);
    return c ? make(cid, c, () => V.city(cid)) : "the settlement could not be read";
  };

  // Players.grantYield, per the yields watched 2026-09-18 on 1.5.0.
  const Y = {
    refusal: (name, isNode) => {
      if (name === "YIELD_FOOD" || name === "YIELD_PRODUCTION") return "grantYield does nothing for Food or Production (watched)";
      if (yt(name) === null || yt(name) === undefined) return `unknown yield ${name}`;
      return isNode && args.amount < 0 ? `${name} only adds; a negative grant does nothing (watched)` : null;
    },
    pool: (name) => {
      const read = () => V.pool(name);
      const before = read();
      if (typeof before !== "number") return `cannot read player ${pid}'s ${name} balance`;
      return {
        before, read, minWait: settleMs, send: () => Players.grantYield(pid, yt(name), args.amount),
        landed: (v) => sign(before, v, args.amount),
        inverse: () => ({ op: "player.yield", args: { ...args, amount: -args.amount } }),
      };
    },
    node: (name) => {
      const read = () => V.node(name === "YIELD_SCIENCE" ? "tech" : "civic");
      const before = read();
      if (before.node === null) return "nothing is being researched in that tree; choose a node first";
      return {
        before, read, minWait: settleMs, send: () => Players.grantYield(pid, yt(name), args.amount),
        landed: (v) => v.node !== before.node || v.progress > before.progress,
      };
    },
  };

  // Each action reads the state as it is and returns { before, read, landed, send, inverse?, restore?, ... },
  // or a string: the reason it is refused.
  const OPS = {
    "player.yield": () => {
      const name = args.yield;
      const isNode = name === "YIELD_SCIENCE" || name === "YIELD_CULTURE";
      const problem = Y.refusal(name, isNode);
      if (problem) return problem;
      return isNode ? Y.node(name) : Y.pool(name);
    },
    "player.celebrate": () => {
      const read = () => V.pool("YIELD_HAPPINESS");
      const threshold = safe(() => P().Happiness.nextGoldenAgeThreshold);
      const before = read();
      if (typeof threshold !== "number" || threshold <= 0 || typeof before !== "number") {
        return "cannot read the celebration meter or its threshold";
      }
      const need = Math.ceil(threshold - before);
      return {
        before, read, minWait: settleMs, extra: { granted: need, threshold },
        send: () => Players.grantYield(pid, yt("YIELD_HAPPINESS"), need),
        landed: (v) => typeof v === "number" && v >= threshold,
        inverse: () => ({ op: "player.yield", args: { player: pid, yield: "YIELD_HAPPINESS", amount: -need } }),
      };
    },
    "player.attribute": () => {
      const read = () => safe(() => P().Identity.getWildcardPoints());
      const before = read();
      if (typeof before !== "number") return "cannot read wildcard attribute points";
      if (!fn(() => P().Identity.addWildcardAttributePoints)) return "this build has no Identity.addWildcardAttributePoints";
      return {
        before, read, landed: (v) => v > before, send: () => P().Identity.addWildcardAttributePoints(args.amount),
      };
    },
    "unit.heal": () => withUnit((cid, u, read) => {
      if (!fn(() => Units.setDamage)) return "this build has no Units.setDamage";
      if (typeof u.damage !== "number") return "cannot read the unit's damage";
      const to = args.to ?? 0;
      return {
        before: u, read, landed: (v) => v?.damage === to, send: () => Units.setDamage(cid, to),
        inverse: () => (u.damage > to
          ? { op: "unit.damage", args: { player: pid, unit: cid.id, amount: u.damage - to } }
          : { op: "unit.heal", args: { player: pid, unit: cid.id, to: u.damage } }),
      };
    }),
    "unit.damage": () => withUnit((cid, u, read) => {
      if (typeof u.damage !== "number" || typeof u.maxDamage !== "number") return "cannot read the unit's health";
      if (u.damage + args.amount >= u.maxDamage) {
        return `that would kill the unit (${u.damage}/${u.maxDamage} damage); use unit.kill`;
      }
      return {
        before: u, read, landed: (v) => v?.damage > u.damage, send: () => Units.get(cid).Health.damageUnit(args.amount),
        inverse: () => (fn(() => Units.setDamage)
          ? { op: "unit.heal", args: { player: pid, unit: cid.id, to: u.damage } } : null),
      };
    }),
    "unit.xp": () => withUnit((cid, u, read) => {
      if (!fn(() => Units.changeExperience)) return "this build has no Units.changeExperience";
      if (typeof u.xp !== "number") return "cannot read the unit's experience";
      const delta = args.to === undefined ? args.amount : args.to - u.xp;
      return {
        before: u, read, extra: { delta }, send: () => Units.changeExperience(cid, delta),
        landed: (v) => typeof v?.xp === "number" && Math.sign(v.xp - u.xp) === Math.sign(delta),
      };
    }),
    "unit.promote": () => withUnit((cid, u, read) => {
      if (cid.owner !== local) return "a promotion is a unit command, which the engine takes only for the local player's units";
      if (!safe(() => GameInfo.UnitPromotions.lookup(args.promotion))) return `unknown promotion ${args.promotion}`;
      if (!safe(() => GameInfo.UnitPromotionDisciplines.lookup(args.discipline))) return `unknown discipline ${args.discipline}`;
      const kind = G.UnitCommandTypes?.PROMOTE ?? "UNITCOMMAND_PROMOTE";
      const req = {
        PromotionType: Database.makeHash(args.promotion), PromotionDisciplineType: Database.makeHash(args.discipline),
      };
      return {
        before: u, read, landed: (v) => v?.promotions > u.promotions,
        canStart: () => safe(() => plain(Game.UnitCommands.canStart(cid, kind, req, false))),
        send: () => Game.UnitCommands.sendRequest(cid, kind, req),
      };
    }),
    "unit.moves": () => withUnit((cid, u, read) => {
      if (!fn(() => Units.restoreMovement)) return "this build has no Units.restoreMovement";
      if (typeof u.moves !== "number") return "cannot read the unit's movement";
      const full = (v) => (typeof v?.maxMoves === "number" ? v.moves >= v.maxMoves : v?.moves > u.moves);
      return { before: u, read, landed: full, send: () => Units.restoreMovement(cid) };
    }),
    "unit.move": () => withUnit((cid, u) => {
      const to = { x: args.toX, y: args.toY };
      if (!onMap(to.x, to.y)) return `(${to.x}, ${to.y}) is not on the map`;
      if (u.x === to.x && u.y === to.y) return "the unit is already on that plot";
      const row = safe(() => GameInfo.Units.lookup(u.type));
      if (!row) return `unknown unit type ${u.type}`;
      if (row.Domain === "DOMAIN_LAND" && safe(() => GameplayMap.isWater(to.x, to.y))) {
        return "a land unit sent to a water plot is discarded without an error (watched 2026-09-29); choose a land plot";
      }
      const there = () => safe(() => MapUnits.getUnits(to.x, to.y), []) || [];
      const had = new Set(there().map((c) => `${c.owner}:${c.id}`));
      const fresh = () => there().find((c) => !had.has(`${c.owner}:${c.id}`) && c.owner === cid.owner
        && safe(() => GameInfo.Units.lookup(Units.get(c).type).UnitType) === u.type) ?? null;
      const alive = () => F.ownUnits().some((c) => c.id === cid.id);
      const read = () => ({ old: alive() ? { x: u.x, y: u.y, id: cid.id } : null, fresh: fresh()?.id ?? null });
      return {
        before: read(), read, landed: (v) => v.fresh !== null && v.old === null,
        send: async () => {
          send("CREATE_ELEMENT", { Kind: "UNIT", Type: u.type, Location: to, Owner: cid.owner });
          const t0 = Date.now();
          while (!fresh() && Date.now() - t0 < waitMs) await sleep(50);
          if (!fresh()) return "the new unit never appeared, so the old one was kept";
          return send("DESTROY_ELEMENT", { Kind: "UNIT", Owner: cid.owner, LocalID: cid.id });
        },
        inverse: (after) => ({ op: "unit.move", args: { player: pid, unit: after.fresh, toX: u.x, toY: u.y } }),
        restore: (after) => (after.fresh !== null ? { op: "unit.kill", args: { player: pid, unit: after.fresh } } : null),
      };
    }),
    "unit.kill": () => withUnit((cid, u) => {
      const read = () => (F.ownUnits().some((c) => c.id === cid.id) ? V.unit(cid) : null);
      const req = { Kind: "UNIT", Owner: cid.owner, LocalID: cid.id };
      return {
        before: u, read, landed: (v) => v === null, send: () => send("DESTROY_ELEMENT", req),
        canStart: canStartOf("DESTROY_ELEMENT", req),
        inverse: () => (u.type && Number.isInteger(u.x)
          ? { op: "unit.place", args: { x: u.x, y: u.y, owner: cid.owner, type: u.type } } : null),
      };
    }),
    "city.production": () => withCity((cid, c, read) => {
      if (queueEmpty(c)) return "the build queue is empty, so nothing would receive the progress (watched)";
      if (typeof c.progress !== "number") return "cannot read the build progress";
      if (args.amount < 0 && c.progress <= 0) return "progress is already 0, and it floors there (watched)";
      return {
        before: c, read, send: () => Cities.get(cid).BuildQueue.addProgress(args.amount),
        landed: (v) => v.item !== c.item || sign(c.progress, v.progress, args.amount),
        inverse: (after) => (after.item === c.item && after.progress > 0
          ? { op, args: { ...args, amount: -args.amount } } : null),
      };
    }),
    "city.complete": () => withCity((cid, c, read) => {
      if (queueEmpty(c)) return "the build queue is empty: there is nothing to complete";
      if (typeof c.progress !== "number" || typeof c.required !== "number") return "cannot read the build progress";
      const need = Math.max(1, Math.ceil(c.required - c.progress));
      return {
        before: c, read, extra: { granted: need }, send: () => Cities.get(cid).BuildQueue.addProgress(need),
        landed: (v) => v.item !== c.item || v.progress < c.progress || v.empty === true,
      };
    }),
    "city.grow": () => withCity((cid, c, read) => {
      if (typeof c.population !== "number") return "cannot read the population";
      if (!fn(() => Cities.get(cid).addRuralPopulation)) return "this build has no city.addRuralPopulation";
      return {
        before: c, read, send: () => Cities.get(cid).addRuralPopulation(1),
        landed: (v) => v.population > c.population || (v.pending ?? 0) > (c.pending ?? 0),
      };
    }),
    "progress.complete": () => {
      const read = () => V.node(args.tree);
      const before = read();
      if (before.node === null) return `nothing is being researched in player ${pid}'s ${args.tree} tree`;
      if (typeof before.cost !== "number") return "cannot read the node's cost";
      const need = Math.max(1, Math.ceil(before.cost - (before.progress ?? 0)));
      const y = yt(args.tree === "tech" ? "YIELD_SCIENCE" : "YIELD_CULTURE");
      return {
        before, read, minWait: settleMs, extra: { granted: need }, send: () => Players.grantYield(pid, y, need),
        landed: (v) => v.node !== before.node || v.depth > before.depth || v.progress >= before.cost,
      };
    },
    "progress.grant": () => {
      if (pid !== local) return "choosing a tech or civic is a player operation the engine takes only for the local player";
      if (!safe(() => GameInfo.ProgressionTreeNodes.lookup(args.node))) return `unknown node ${args.node}`;
      const tech = args.tree === "tech";
      const sub = safe(() => (tech ? P().Techs : P().Culture));
      const name = tech ? "SET_TECH_TREE_NODE" : "SET_CULTURE_TREE_NODE";
      const kind = G.PlayerOperationTypes?.[name] ?? name;
      const req = { ProgressionTreeNodeType: GameInfo.ProgressionTreeNodes.lookup(args.node).$hash };
      const read = () => ({
        unlocked: !!safe(() => sub.isNodeUnlocked(args.node)), active: V.node(args.tree).name ?? null,
      });
      const chosen = () => V.node(args.tree);
      return {
        before: read(), read, minWait: settleMs, landed: (v) => v.unlocked,
        canStart: canStartOf(kind, req),
        send: async () => {
          send(kind, req);
          const t0 = Date.now();
          while (chosen().name !== args.node && Date.now() - t0 < waitMs) await sleep(50);
          const n = chosen();
          if (n.name !== args.node) return "the node was not chosen, so nothing was granted";
          const need = Math.max(1, Math.ceil((n.cost ?? 0) - (n.progress ?? 0)));
          return Players.grantYield(pid, yt(tech ? "YIELD_SCIENCE" : "YIELD_CULTURE"), need);
        },
      };
    },
    "map.reveal": () => {
      const hidden = G.RevealedStates?.HIDDEN ?? 0;
      const state = (x, y) => safe(() => GameplayMap.getRevealedState(pid, x, y));
      if (Number.isInteger(args.x)) {
        if (!onMap(args.x, args.y)) return `(${args.x}, ${args.y}) is not on the map`;
        const read = () => state(args.x, args.y);
        const loc = { x: args.x, y: args.y };
        return {
          before: read(), read, landed: (v) => v !== null && v !== hidden,
          send: () => WorldBuilder.MapPlots.setRevealed(pid, loc, true),
        };
      }
      if (!fn(() => G.Visibility.revealAllPlots)) return "this build has no Visibility.revealAllPlots";
      const w = safe(() => GameplayMap.getGridWidth(), 0);
      const n = w * safe(() => GameplayMap.getGridHeight(), 0);
      const step = Math.max(1, Math.floor(n / 600));
      const sample = Array.from({ length: Math.ceil(n / step) }, (_, k) => k * step);
      // A spread sample of plots stands in for the whole map: reading every plot each poll is slow.
      const read = () => sample.filter((i) => state(i % w, Math.floor(i / w)) === hidden).length;
      return {
        before: read(), read, landed: (v) => v === 0, send: () => G.Visibility.revealAllPlots(pid),
        extra: { sampled: sample.length },
      };
    },
    "map.owner": () => {
      const loc = { x: args.x, y: args.y };
      if (!onMap(loc.x, loc.y)) return `(${loc.x}, ${loc.y}) is not on the map`;
      if (F.centre(loc.x, loc.y)) return "that plot is a settlement's centre";
      const cid = F.city();
      if (!cid) return `player ${pid} has no city ${args.city}`;
      if (!fn(() => Cities.get(cid).purchasePlot)) return "this build has no city.purchasePlot";
      const read = () => {
        const c = safe(() => GameplayMap.getOwningCityFromXY(loc.x, loc.y));
        return { owner: safe(() => GameplayMap.getOwner(loc.x, loc.y)), city: c ? c.id : null };
      };
      const before = read();
      return {
        before, read, minWait: settleMs, landed: (v) => v.owner === pid && (v.city === null || v.city === cid.id),
        send: () => Cities.get(cid).purchasePlot(loc),
        inverse: () => (before.city !== null && before.owner >= 0 && before.owner !== pid
          ? { op, args: { x: loc.x, y: loc.y, player: before.owner, city: before.city } } : null),
      };
    },
  };

  // Sends, then polls until the action is observed or the wait ends.
  const run = async (spec) => {
    const wait = Math.max(waitMs, spec.minWait ?? 0);
    const t0 = Date.now();
    let returned;
    try {
      returned = await spec.send();
    } catch (e) {
      return { threw: String(e), t0 };
    }
    let landedMs = null;
    while (landedMs === null && Date.now() - t0 < wait) {
      if (spec.landed(spec.read())) landedMs = Date.now() - t0;
      else await sleep(50);
    }
    return { returned: returned === undefined ? null : returned, landedMs, t0 };
  };
  const verify = async (spec) => {
    const before = spec.before;
    const canStart = spec.canStart ? spec.canStart() : undefined;
    const r = await run(spec);
    const after = spec.read();
    if (r.threw) return { verdict: "THREW", reason: r.threw, sent: true, canStart, before, after, inverse: null };
    const changed = r.landedMs === null && JSON.stringify(after) !== JSON.stringify(before);
    const verdict = r.landedMs !== null ? "LANDED" : changed ? "UNEXPECTED" : "NO EFFECT";
    const undo = { LANDED: spec.inverse, UNEXPECTED: spec.restore }[verdict];
    const inverse = undo ? undo(after) ?? null : null;
    return {
      verdict, landedMs: r.landedMs, waitedMs: Date.now() - r.t0, sent: true, returned: r.returned,
      canStart, before, after, inverse, undoable: !!inverse, ...(spec.extra ?? {}),
    };
  };
  const start = () => {
    if (!Object.prototype.hasOwnProperty.call(OPS, op)) return refuse(`unknown action ${op}`);
    if (!Number.isInteger(pid) || !safe(() => Players.get(pid))) return refuse(`player ${pid} does not exist`);
    const spec = safe(() => OPS[op](), "the game state could not be read");
    if (typeof spec === "string") return refuse(spec);
    if (!spec.landed(spec.before)) return verify(spec);
    return { verdict: "ALREADY", reason: "that is already the state; nothing was sent", sent: false, before: spec.before, after: spec.before };
  };
  return start();
}
