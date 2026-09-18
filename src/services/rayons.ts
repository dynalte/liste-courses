/**
 * Rayons de supermarché : suggestion automatique par mots-clés
 * (utilisée à l'ajout : saisie, scan, IA, liste papier).
 */
export const RAYON_DIVERS = 'Divers';

export const RAYON_ORDER = [
  'Fruits & légumes',
  'Boulangerie',
  'Frais',
  'Viandes & poissons',
  'Épicerie',
  'Boissons',
  'Surgelés',
  'Bébé',
  'Entretien',
  'Hygiène',
  'Animal',
  RAYON_DIVERS,
] as const;

const KEYWORDS: Record<string, string[]> = {
  'Fruits & légumes': [
    'tomate', 'pomme', 'banane', 'carotte', 'oignon', 'patate', 'pomme de terre', 'salade',
    'courgette', 'poivron', 'fruit', 'legume', 'orange', 'citron', 'fraise', 'concombre',
    'poireau', 'chou', 'brocoli', 'avocat', 'ail', 'persil', 'basilic', 'champignon',
    'aubergine', 'melon', 'pasteque', 'raisin', 'peche', 'abricot', 'cerise', 'prune',
    'kiwi', 'ananas', 'mangue', 'endive', 'epinard', 'haricot', 'pois', 'radis', 'celeri',
    'fenouil', 'artichaut', 'asperge', 'betterave', 'navet', 'potiron', 'citrouille', 'figue',
  ],
  Boulangerie: [
    'pain', 'baguette', 'croissant', 'brioche', 'viennoiserie', 'pain de mie', 'batard',
    'bâtard', 'fougasse', 'ciabatta', 'croissant', 'pain au chocolat', 'chouquette', 'eclair',
    'sandwich', 'panini', 'wrap', 'tacos',
  ],
  Frais: [
    'lait', 'oeuf', 'beurre', 'yaourt', 'fromage', 'creme', 'camembert', 'comte', 'emmental',
    'mozzarella', 'chevre', 'roquefort', 'cantal', 'mimolette', 'raclette', 'laitage',
    'petit suisse', 'faisselle', 'mascarpone', 'parmesan', 'feta', 'yaourt a boire',
  ],
  'Viandes & poissons': [
    'poulet', 'boeuf', 'porc', 'viande', 'poisson', 'saumon', 'thon', 'steak', 'saucisse',
    'jambon', 'bacon', 'dinde', 'veau', 'agneau', 'crevette', 'cabillaud', 'colin', 'lieu',
    'truite', 'sardine', 'maquereau', 'anchois', 'moule', 'huitre', 'lardon', 'merguez',
    'chipolata', 'cordon bleu', 'nugget', 'escalope', 'roti', 'cote', 'entrecote', 'bavette',
    'charcuterie', 'pate', 'rillettes', 'foie gras', 'boudin', 'hache', 'hachee',
  ],
  'Épicerie': [
    'riz', 'pate', 'farine', 'sucre', 'huile', 'vinaigre', 'sel', 'poivre', 'conserve',
    'sauce', 'cafe', 'the', 'chocolat', 'biscuit', 'cereale', 'miel', 'confiture', 'moutarde',
    'ketchup', 'mayo', 'mayonnaise', 'semoule', 'quinoa', 'epice', 'cumin', 'curry', 'paprika',
    'basilic sec', 'origan', 'thym', 'laurier', 'bouillon', 'cube', 'soupe', 'potage', 'veloute',
    'lentille', 'pois chiche', 'haricot blanc', 'flageolet', 'mais', 'thon en boite', 'sardine en boite',
    'tomate pele', 'coulis', 'sucre glace', 'levure', 'vanille', 'cacao', 'compote', 'sirop derable',
    'pate a tartiner', 'nutella', 'gateau', 'madeleine', 'cookie', 'chips', 'crackers', 'aperitif',
    'olive', 'cornichon', 'capre', 'anchois', 'miettes', 'chapelure', 'fecule', 'gelatine', 'sucre vanille',
  ],
  Boissons: [
    'eau', 'jus', 'soda', 'coca', 'cola', 'vin', 'biere', 'sirop', 'limonade', 'nectar',
    'smoothie', 'cidre', 'champagne', 'whisky', 'rhum', 'vodka', 'pastis', 'the glace',
    'cafe glace', 'energy', 'tonic', 'schweppes', 'perrier', 'badoit', 'evian', 'contrex',
  ],
  'Surgelés': ['surgele', 'glace', 'glaces', 'frites surgelees', 'poisson pane', 'pizza surgelee', 'legume surgele', 'fruits surgele', 'sorbet', 'magnum', 'cornetto'],
  'Bébé': ['couche', 'bebe', 'lait infantile', 'petit pot', 'lingette bebe', 'lait bebe'],
  Entretien: [
    'lessive', 'vaisselle', 'eponge', 'sopalin', 'papier toilette', 'pq', 'sac poubelle',
    'javel', 'nettoyant', 'entretien', 'balai', 'serpilliere', 'aspirateur', 'liquide vaisselle',
    'tablette lave', 'sel regenerant', 'liquide rinçage', 'decapant', 'desinfectant', 'anticalcaire',
    'vitre', 'sols', 'poussiere', 'lingette menage', 'gant', 'torchon', 'congelation', 'aluminium',
    'film alimentaire', 'film etirable',
  ],
  'Hygiène': [
    'savon', 'shampoing', 'dentifrice', 'deodorant', 'hygiene', 'solaire', 'mouchoir',
    'coton', 'brosse a dents', 'gel douche', 'apres shampoing', 'creme', 'lotion', 'parfum',
    'rasoir', 'mousse a raser', 'serviette hygienique', 'tampon', 'papier hygienique',
  ],
  Animal: ['croquette', 'patee', 'litiere', 'chien', 'chat', 'oiseau', 'lapin', 'friandise chien', 'os a macher'],
};

function norm(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

/** Devine le rayon d'après le nom (mots-clés, insensible accents/casse).
 *  - mots courts (≤3 lettres : ail, thé, riz...) : mot entier uniquement
 *    (évite "ail" dans "taille", "the" dans "menthe") ;
 *  - sinon : mot-clé le plus long gagne ("poisson" bat "pois"),
 *    égalité → ordre RAYON_ORDER.
 */
export function suggestRayon(name: string): string {
  const n = ` ${norm(name)} `;
  let best: { rayon: string; len: number } | null = null;
  for (const rayon of RAYON_ORDER) {
    if (rayon === RAYON_DIVERS) continue;
    for (const rawKw of KEYWORDS[rayon] ?? []) {
      const kw = norm(rawKw);
      if (!kw) continue;
      const hit = kw.length <= 3 ? n.includes(` ${kw} `) : n.includes(kw);
      if (!hit) continue;
      if (!best || kw.length > best.len) best = { rayon, len: kw.length };
    }
  }
  return best ? best.rayon : RAYON_DIVERS;
}

/** Rayon suivant dans l'ordre (bouton de cyclage sur la fiche article). */
export function nextRayon(current: string): string {
  const i = (RAYON_ORDER as readonly string[]).indexOf(current);
  return RAYON_ORDER[(i + 1 + RAYON_ORDER.length) % RAYON_ORDER.length];
}
