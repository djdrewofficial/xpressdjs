/**
 * Event-type matching for the Check Availability inquiry.
 *
 * The form's option values are canonical English on both languages
 * ("Wedding", "Corporate Event", "Other", plus the Other subtypes).
 * Labels differ (Spanish "Boda", "Quinceañera", …). Matching folds case,
 * accents, and spacing so a label or a differently cased value still maps
 * to one canonical CRM value.
 *
 * Only a canonical Wedding offers the consultation calendar. "Wedding
 * Anniversary" and any other subtype are not weddings.
 */

export const EVENT_TYPES = ["Wedding", "Corporate Event", "Other"];

export const OTHER_EVENT_TYPES = [
  "Banquet", "Bar Mitzvah", "Bat Mitzvah", "Birthday Party", "Class Reunion", "Community Celebration",
  "Company Holiday Party", "Family Reunion", "Graduation Celebration", "Night Club / Bar Dance",
  "Private Party", "Quinceanera", "PA / Sound Reinforcement", "School Dance", "Sweet 16",
  "Wedding Anniversary", "Other / Not Listed",
];

/** Folded parent values that mean Wedding. The real `<option value>` is "Wedding". */
export const WEDDING_ALIASES = ["wedding", "weddings", "boda", "bodas"];

/** Folded parent values that mean Other. The real `<option value>` is "Other". */
export const OTHER_PARENT_ALIASES = ["other", "otro"];

// Spanish labels from the ES form, folded back to the English CRM value.
const OTHER_LABELS = [
  ["Banquete", "Banquet"],
  ["Bar Mitzvá", "Bar Mitzvah"],
  ["Bat Mitzvá", "Bat Mitzvah"],
  ["Fiesta de Cumpleaños", "Birthday Party"],
  ["Reunión de Egresados", "Class Reunion"],
  ["Celebración Comunitaria", "Community Celebration"],
  ["Fiesta Navideña de Empresa", "Company Holiday Party"],
  ["Reunión Familiar", "Family Reunion"],
  ["Celebración de Graduación", "Graduation Celebration"],
  ["Club Nocturno / Baile en Bar", "Night Club / Bar Dance"],
  ["Fiesta Privada", "Private Party"],
  ["Quinceañera", "Quinceanera"],
  ["PA / Refuerzo de Sonido", "PA / Sound Reinforcement"],
  ["Baile Escolar", "School Dance"],
  ["Aniversario de Bodas", "Wedding Anniversary"],
  ["Otro / No Listado", "Other / Not Listed"],
];

const EVENT_TYPE_BY_FOLD = new Map();
const OTHER_BY_FOLD = new Map();

/** Lowercase, strip accents, treat punctuation as spaces. */
export function fold(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function addFold(map, alias, canonical) {
  const key = fold(alias);
  if (key) map.set(key, canonical);
}

for (const value of EVENT_TYPES) addFold(EVENT_TYPE_BY_FOLD, value, value);
for (const alias of WEDDING_ALIASES) addFold(EVENT_TYPE_BY_FOLD, alias, "Wedding");
addFold(EVENT_TYPE_BY_FOLD, "corporate", "Corporate Event");
addFold(EVENT_TYPE_BY_FOLD, "evento corporativo", "Corporate Event");
for (const alias of OTHER_PARENT_ALIASES) addFold(EVENT_TYPE_BY_FOLD, alias, "Other");

for (const value of OTHER_EVENT_TYPES) addFold(OTHER_BY_FOLD, value, value);
for (const [label, canonical] of OTHER_LABELS) addFold(OTHER_BY_FOLD, label, canonical);

/** Canonical parent event type, or "" when it is not one we accept. */
export function canonicalEventType(raw) {
  return EVENT_TYPE_BY_FOLD.get(fold(raw)) || "";
}

/** Canonical "Other" subtype, or "" when it is not one we accept. */
export function canonicalOtherEventType(raw) {
  return OTHER_BY_FOLD.get(fold(raw)) || "";
}

/**
 * True only for a wedding. Subtypes are ignored here on purpose: anniversary
 * and quinceañera are submitted as eventType "Other" plus a subtype, and a
 * string like "Wedding Anniversary" does not canonicalize to Wedding.
 */
export function isWeddingEvent(eventType) {
  return canonicalEventType(eventType) === "Wedding";
}

/** Server flag and the submitted event type both have to say wedding. */
export function shouldOfferConsult(serverBookConsult, eventType) {
  return serverBookConsult === true && isWeddingEvent(eventType);
}
