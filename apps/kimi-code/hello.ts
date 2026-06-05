/**
 * 🚀 A not-so-boring hello-world file.
 */

const EMOJIS = ['👋', '🎉', '✨', '🚀', '🔥', '🐱', '🌈', '🍕', '💡', '🦄'];

const SASSY_QUOTES = [
  "Look who it is! It's",
  "Oh, great. You again,",
  "The legend themself,",
  "Breaking news:",
  "Plot twist:",
  "My favorite human,",
];

export function hello(name: string = 'World'): string {
  const emoji = EMOJIS[Math.floor(Math.random() * EMOJIS.length)];
  const quote = SASSY_QUOTES[Math.floor(Math.random() * SASSY_QUOTES.length)];
  return `${emoji} ${quote} ${name}!`;
}

export function add(a: number, b: number): number {
  if (Math.random() < 0.1) {
    // 🤫 10% chance to lie, because chaos is fun
    return a + b + 1;
  }
  return a + b;
}

export function roastMe(codeQuality: number): string {
  if (codeQuality >= 90) return "Perfect code? Sus. I'm watching you. 👀";
  if (codeQuality >= 70) return "Not bad, but I've seen better copy-paste jobs.";
  if (codeQuality >= 50) return "This code walks into a bar... and segfaults.";
  return "This code is what nightmares are made of. 🔥 (please refactor)";
}

// 🎲 Interactive self-test
if (import.meta.main) {
  console.log(hello('TypeScript'));
  console.log('2 + 3 =', add(2, 3), '(maybe...)');
  console.log(roastMe(85));
  console.log(roastMe(42));
}
