import type { GameHistoryItem, Tournament } from "../types";

export const games: GameHistoryItem[] = [
  {
    white: "Piotr",
    black: "Alicja",
    result: "1–0",
    mode: "Blitz 5+0",
    elo: "+8",
  },
  {
    white: "Tomasz",
    black: "Piotr",
    result: "½–½",
    mode: "Rapid 10+0",
    elo: "+1",
  },
  {
    white: "Piotr",
    black: "Bartek",
    result: "0–1",
    mode: "Blitz 3+2",
    elo: "-7",
  },
];

export const tournaments: Tournament[] = [
  {
    name: "Evening Arena",
    mode: "Blitz 5+0",
    players: "128 players",
    startsAt: "Today, 20:00",
  },
  {
    name: "Rapid Cup #12",
    mode: "Rapid 10+0",
    players: "64 players",
    startsAt: "Saturday, 18:00",
  },
  {
    name: "Weekend Swiss",
    mode: "7 rounds",
    players: "92 players",
    startsAt: "Sunday, 16:00",
  },
];

export const ranking = [
  ["Przemek", 2118],
  ["Bartek", 1987],
  ["Tomasz", 1762],
  ["Alicja", 1571],
  ["Piotr", 1542],
] as const;
