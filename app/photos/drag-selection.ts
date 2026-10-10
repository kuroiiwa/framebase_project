export type SelectionRect = { left: number; top: number; right: number; bottom: number };

export function selectionRect(x1: number, y1: number, x2: number, y2: number): SelectionRect {
  return { left: Math.min(x1, x2), top: Math.min(y1, y2), right: Math.max(x1, x2), bottom: Math.max(y1, y2) };
}

export function intersectingPhotos(rect: SelectionRect, cards: Array<{ id: string; rect: SelectionRect }>) {
  return cards.filter(card => rect.left < card.rect.right && rect.right > card.rect.left && rect.top < card.rect.bottom && rect.bottom > card.rect.top).map(card => card.id);
}

export function mergeDragSelection(initial: string[], hits: string[], remove: boolean, limit: number) {
  const hitSet = new Set(hits);
  return remove ? initial.filter(id => !hitSet.has(id)) : [...new Set([...initial, ...hits])].slice(0, limit);
}
