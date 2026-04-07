import { shortId } from "../utils/ids";
import { consumeLastDbError, readDb, writeDb } from "../storage/db";
import type { Context } from "telegraf";

export type FamilyCard = {
  id: string;
  userId: number;
  childName: string;
  age: string;
  symptoms: string;
  medications: string[];
  analysis: any;
  createdAt: number;
};

function normalizeFamilyCard(raw: any): FamilyCard {
  const childName =
    typeof raw?.childName === "string" && raw.childName.trim()
      ? raw.childName.trim()
      : typeof raw?.child === "string" && raw.child.trim()
      ? raw.child.trim()
      : "Не указано";

  return {
    id: String(raw?.id ?? ""),
    userId: Number(raw?.userId ?? 0),
    childName,
    age: String(raw?.age ?? ""),
    symptoms: String(raw?.symptoms ?? ""),
    medications: Array.isArray(raw?.medications) ? raw.medications : [],
    analysis: raw?.analysis ?? {},
    createdAt: Number(raw?.createdAt ?? Date.now())
  };
}

export function createFamilyCard(
  input: Omit<FamilyCard, "id" | "createdAt" | "childName"> & { childName?: string },
  options?: { ctx?: Context }
): FamilyCard {
  const db = readDb();
  const dbError = consumeLastDbError();
  const card: FamilyCard = {
    ...input,
    childName:
      typeof input.childName === "string" && input.childName.trim() ? input.childName.trim() : "Не указано",
    id: shortId(),
    createdAt: Date.now()
  };
  db.cards.push(card);
  db.history.push({
    userId: input.userId,
    cardId: card.id,
    timestamp: Date.now()
  });
  writeDb(db);

  if (dbError && options?.ctx) {
    options.ctx
      .reply(
        "⚠️ Карточка сохранена, но предыдущие данные базы были повреждены и сброшены. Пожалуйста, проверьте историю вручную."
      )
      .catch(() => undefined);
  }

  return card;
}

export function getFamilyCard(cardId: string): FamilyCard | undefined {
  const db = readDb();
  const raw = db.cards.find((x: any) => x?.id === cardId);
  return raw ? normalizeFamilyCard(raw) : undefined;
}

export function getUserHistory(userId: number): FamilyCard[] {
  const db = readDb();
  const items = db.history
    .filter((h: any) => h.userId === userId)
    .sort((a: any, b: any) => b.timestamp - a.timestamp)
    .slice(0, 10);

  return items
    .map((h: any) => db.cards.find((c: any) => c?.id === h.cardId))
    .filter(Boolean)
    .map((card: any) => normalizeFamilyCard(card));
}

export function getShareLink(botUsername: string, cardId: string): string {
  return `https://t.me/${botUsername}?start=card_${cardId}`;
}
