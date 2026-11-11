// -----------------------------------------------------------------------------
// Runtime texts, English and French: feature names, the status of the
// configuration screen and the answer of the Test button.
// -----------------------------------------------------------------------------

export const TEXTS = {
  featurePrice: { en: 'Price now (NOK/kWh)', fr: 'Prix actuel (NOK/kWh)' },
  featureCapacity: {
    en: 'Capacity peak this month (kW)',
    fr: 'Pointe de puissance du mois (kW)',
  },
  featureCapacityFee: {
    en: 'Capacity step this month (NOK/month)',
    fr: 'Palier de puissance du mois (NOK/mois)',
  },
  featureNextStep: { en: 'Next capacity step from (kW)', fr: 'Palier suivant à partir de (kW)' },

  noContract: {
    en: 'Ready. Create a contract with the "Nettleie (Norway)" template in Energy > Contracts. Data: fri-nettleie of {date} (CC BY 4.0).',
    fr: 'Prêt. Créez un contrat avec le modèle « Nettleie (Norvège) » dans Énergie > Contrats. Données : fri-nettleie du {date} (CC BY 4.0).',
  },
  ready: {
    en: '{count} contract(s). Data: fri-nettleie of {date} (CC BY 4.0).',
    fr: '{count} contrat(s). Données : fri-nettleie du {date} (CC BY 4.0).',
  },
  problem: { en: ' Problem: {problem}', fr: ' Problème : {problem}' },
  storage: {
    en: ' /data unreadable: the capacity and the spot prices are not kept.',
    fr: ' /data illisible : la puissance et les prix spot ne sont pas gardés.',
  },
  paused: {
    en: ' {service} asks to wait (HTTP {status}): paused until {time}.',
    fr: ' {service} demande d’attendre (HTTP {status}) : pause jusqu’à {time}.',
  },
  spotCredit: {
    en: ' Strømpriser levert av Hva koster strømmen.no.',
    fr: ' Strømpriser levert av Hva koster strømmen.no.',
  },
  stale: {
    en: ' The data of {company} was last checked on {date}: prices not verified this year.',
    fr: ' Les données de {company} ont été vérifiées pour la dernière fois le {date} : prix non vérifiés cette année.',
  },
  zoneMismatch: {
    en: ' Tax zone "{zone}" does not match the county of {company}: check it.',
    fr: ' La zone fiscale « {zone} » ne correspond pas au comté de {company} : vérifiez-la.',
  },
  configUnread: {
    en: 'The configuration could not be read from Gladys: trying again.',
    fr: 'La configuration n’a pas pu être lue depuis Gladys : nouvel essai.',
  },
  contractsUnread: {
    en: ' The contracts could not be read from Gladys: trying again.',
    fr: ' Les contrats n’ont pas pu être lus depuis Gladys : nouvel essai.',
  },

  testNone: {
    en: 'No contract uses the "Nettleie (Norway)" template yet. Data: fri-nettleie of {date}, {count} grid companies.',
    fr: 'Aucun contrat n’utilise encore le modèle « Nettleie (Norvège) ». Données : fri-nettleie du {date}, {count} gestionnaires.',
  },
  testContract: {
    en: '{company} (data of {date}): energy {ore} øre/kWh now without taxes, price now {price} NOK/kWh with taxes.',
    fr: '{company} (données du {date}) : énergie {ore} øre/kWh hors taxes maintenant, prix actuel {price} NOK/kWh taxes comprises.',
  },
  testCapacity: {
    en: ' Capacity this month: {kw} kW, step {fee} NOK/month.',
    fr: ' Puissance du mois : {kw} kW, palier {fee} NOK/mois.',
  },
  testNoCapacity: {
    en: ' Capacity step: not computed ({method}).',
    fr: ' Palier de puissance : non calculé ({method}).',
  },
  testNveSame: { en: ' NVE: same values today.', fr: ' NVE : mêmes valeurs aujourd’hui.' },
  testNveDiff: {
    en: ' NVE differs today ({detail}); the prices use fri-nettleie.',
    fr: ' NVE diffère aujourd’hui ({detail}) ; les prix suivent fri-nettleie.',
  },
  testNveNone: { en: ' NVE: not compared ({reason}).', fr: ' NVE : non comparé ({reason}).' },
  testError: { en: 'Contract {id}: {problem}', fr: 'Contrat {id} : {problem}' },
};

/** `{ en, fr }` with `{name}` placeholders filled. */
export function text(key, values = {}) {
  const fill = (s) => s.replace(/\{(\w+)\}/g, (m, k) => (k in values ? String(values[k]) : m));
  return { en: fill(TEXTS[key].en), fr: fill(TEXTS[key].fr) };
}

/** Joins `{ en, fr }` parts. */
export function join(...parts) {
  return {
    en: parts.map((p) => p.en).join(''),
    fr: parts.map((p) => p.fr).join(''),
  };
}

/** The same text in both languages (a technical detail). */
export const both = (s) => ({ en: s, fr: s });
