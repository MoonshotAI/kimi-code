export function measureBrowserOverlayCard(card: HTMLElement): { width: number; height: number } {
  const style = getComputedStyle(card);
  return {
    width: Math.ceil(Number.parseFloat(style.width) || card.offsetWidth),
    height: Math.ceil(Number.parseFloat(style.height) || card.offsetHeight),
  };
}
