export type Medication = {
  id: string;
  slug: string;
  name: string;
  generic: string;
  category: string;
  role: string;
  synonyms: string[];
};

export const MEDICATIONS: Medication[] = [
  {
    id: "m1",
    slug: "paracetamol",
    name: "Парацетамол",
    generic: "Paracetamol",
    category: "Жаропонижающее",
    role: "снижает температуру",
    synonyms: ["парацетамол", "панадол", "panadol", "paracetamol"]
  },
  {
    id: "m2",
    slug: "ibuprofen",
    name: "Ибупрофен / Нурофен",
    generic: "Ibuprofen",
    category: "НПВП",
    role: "снижает боль и жар",
    synonyms: ["ибупрофен", "нурофен", "ibuprofen", "nurofen"]
  },
  {
    id: "m3",
    slug: "amoxicillin",
    name: "Амоксициллин",
    generic: "Amoxicillin",
    category: "Антибиотик",
    role: "борется с бактериальной инфекцией",
    synonyms: ["амоксициллин", "amoxicillin"]
  },
  {
    id: "m4",
    slug: "amoxiclav",
    name: "Амоксиклав",
    generic: "Amoxicillin + Clavulanic acid",
    category: "Антибиотик",
    role: "защищенный антибиотик",
    synonyms: ["амоксиклав", "amoxiclav"]
  },
  {
    id: "m5",
    slug: "azithromycin",
    name: "Азитромицин / Сумамед",
    generic: "Azithromycin",
    category: "Антибиотик",
    role: "макролидный антибиотик",
    synonyms: ["азитромицин", "сумамед", "azithromycin", "sumamed"]
  },
  {
    id: "m6",
    slug: "cetirizine",
    name: "Цетиризин / Зиртек",
    generic: "Cetirizine",
    category: "Антигистамин",
    role: "снимает аллергические симптомы",
    synonyms: ["цетиризин", "зиртек", "cetirizine", "zyrtec", "zirtek"]
  },
  {
    id: "m7",
    slug: "loratadine",
    name: "Лоратадин / Кларитин",
    generic: "Loratadine",
    category: "Антигистамин",
    role: "снимает аллергические симптомы",
    synonyms: ["лоратадин", "кларитин", "loratadine", "claritin", "klaritin"]
  },
  {
    id: "m8",
    slug: "salbutamol",
    name: "Сальбутамол / Вентолин",
    generic: "Salbutamol",
    category: "Бронхолитик",
    role: "снимает бронхоспазм",
    synonyms: ["сальбутамол", "вентолин", "salbutamol", "ventolin"]
  },
  {
    id: "m9",
    slug: "budesonide",
    name: "Будесонид / Пульмикорт",
    generic: "Budesonide",
    category: "Стероид",
    role: "снижает воспаление в дыхательных путях",
    synonyms: ["будесонид", "пульмикорт", "budesonide", "pulmicort"]
  },
  {
    id: "m10",
    slug: "montelukast",
    name: "Монтелукаст / Сингуляр",
    generic: "Montelukast",
    category: "Контроль астмы",
    role: "используется для контроля симптомов",
    synonyms: ["монтелукаст", "сингуляр", "montelukast", "singulair"]
  },
  {
    id: "m11",
    slug: "ambroxol",
    name: "Амброксол / Лазолван",
    generic: "Ambroxol",
    category: "Муколитик",
    role: "разжижает мокроту",
    synonyms: ["амброксол", "лазолван", "ambroxol", "lasolvan", "lazolvan"]
  },
  {
    id: "m12",
    slug: "acetylcysteine",
    name: "Ацетилцистеин / АЦЦ",
    generic: "Acetylcysteine",
    category: "Муколитик",
    role: "помогает отхождению мокроты",
    synonyms: ["ацетилцистеин", "ацц", "acetylcysteine", "acc", "nac"]
  },
  {
    id: "m13",
    slug: "omeprazole",
    name: "Омепразол",
    generic: "Omeprazole",
    category: "Гастропротектор",
    role: "снижает кислотность желудка",
    synonyms: ["омепразол", "omeprazole", "омез", "omez"]
  },
  {
    id: "m14",
    slug: "metformin",
    name: "Метформин",
    generic: "Metformin",
    category: "Антидиабетический",
    role: "используется при сахарном диабете 2 типа",
    synonyms: ["метформин", "metformin", "глюкофаж", "glucophage"]
  }
];

export function parseMedications(input: string): Medication[] {
  const parts = input
    .split(",")
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);

  const found: Medication[] = [];

  for (const part of parts) {
    const med = MEDICATIONS.find((m) =>
      m.synonyms.some((s) => s.toLowerCase().includes(part) || part.includes(s.toLowerCase()))
    );
    if (med && !found.some((f) => f.id === med.id)) {
      found.push(med);
    }
  }

  return found;
}
