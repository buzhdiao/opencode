// Slug 命名空间：生成可读的随机短名称（如 "brave-falcon"）
export namespace Slug {
  // 形容词词库（随机名的第一段）
  const ADJECTIVES = [
    "brave",
    "calm",
    "clever",
    "cosmic",
    "crisp",
    "curious",
    "eager",
    "gentle",
    "glowing",
    "happy",
    "hidden",
    "jolly",
    "kind",
    "lucky",
    "mighty",
    "misty",
    "neon",
    "nimble",
    "playful",
    "proud",
    "quick",
    "quiet",
    "shiny",
    "silent",
    "stellar",
    "sunny",
    "swift",
    "tidy",
    "witty",
  ] as const

  // 名词词库（随机名的第二段）
  const NOUNS = [
    "cabin",
    "cactus",
    "canyon",
    "circuit",
    "comet",
    "eagle",
    "engine",
    "falcon",
    "forest",
    "garden",
    "harbor",
    "island",
    "knight",
    "lagoon",
    "meadow",
    "moon",
    "mountain",
    "nebula",
    "orchid",
    "otter",
    "panda",
    "pixel",
    "planet",
    "river",
    "rocket",
    "sailor",
    "squid",
    "star",
    "tiger",
    "wizard",
    "wolf",
  ] as const

  // 生成一个 "形容词-名词" 形式的随机短名称
  export function create() {
    return [
      // 随机挑选一个形容词
      ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)],
      // 随机挑选一个名词
      NOUNS[Math.floor(Math.random() * NOUNS.length)],
    ].join("-")
  }
}
