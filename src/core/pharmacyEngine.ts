export type PharmacyLocale = "ru" | "uz";

export function getArzonAptekaSearchUrl(query: string, locale: PharmacyLocale): string {
  const normalizedLocale: PharmacyLocale = locale === "uz" ? "uz" : "ru";
  return `https://arzonapteka.uz/${normalizedLocale}/search-medicines?q=${encodeURIComponent(query)}`;
}
