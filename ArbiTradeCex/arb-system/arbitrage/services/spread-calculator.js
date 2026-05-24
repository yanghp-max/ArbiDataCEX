export function calcSpreads(tick, totalCostPct) {
  const spreadAb = ((tick.aBid - tick.bAsk) / tick.bAsk) * 100;
  const spreadBa = ((tick.bBid - tick.aAsk) / tick.aAsk) * 100;
  return {
    spreadAb,
    spreadBa,
    spreadAbAdj: spreadAb - totalCostPct,
    spreadBaAdj: spreadBa - totalCostPct
  };
}

export function pickDirection(signal, spreadAbAdj, spreadBaAdj, zOpenAb, zOpenBa) {
  const canAb = signal.zAb != null && signal.zAb >= zOpenAb;
  const canBa = signal.zBa != null && signal.zBa >= zOpenBa;
  if (!canAb && !canBa) return null;
  let direction;
  if (canAb && canBa) direction = signal.zAb >= signal.zBa ? '-a+b' : '+a-b';
  else direction = canAb ? '-a+b' : '+a-b';
  const adjSpread = direction === '-a+b' ? spreadAbAdj : spreadBaAdj;
  const zUsed = direction === '-a+b' ? signal.zAb : signal.zBa;
  return { direction, adjSpread, zUsed };
}
