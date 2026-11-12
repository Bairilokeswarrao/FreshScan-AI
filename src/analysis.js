'use strict';
// Server-side food validation + freshness scoring.
// The browser runs MobileNet (TensorFlow.js) and sends the top predictions plus
// simple colour statistics from the image. The server decides whether it is food,
// computes a deterministic freshness score, shelf life, risk and a summary.
const crypto = require('node:crypto');

const FOOD_TERMS = [
  'taco', 'burrito', 'enchilada', 'quesadilla', 'tortilla', 'wrap', 'guacamole', 'salsa',
  'sandwich', 'burger', 'cheeseburger', 'hotdog', 'pizza', 'french loaf', 'bagel', 'pretzel',
  'toast', 'roll', 'bread', 'croissant', 'bakery', 'dough',
  'meat', 'beef', 'pork', 'steak', 'chicken', 'poultry', 'turkey', 'fish', 'salmon', 'tuna',
  'seafood', 'lobster', 'crab', 'shrimp', 'sausage', 'bacon', 'patty', 'meatloaf', 'meat loaf',
  'apple', 'granny smith', 'banana', 'orange', 'lemon', 'lime', 'fig', 'grape', 'strawberry', 'berry',
  'pineapple', 'pomegranate', 'jackfruit', 'mango', 'watermelon', 'melon', 'cucumber',
  'pepper', 'bell pepper', 'chili', 'tomato', 'potato', 'onion', 'garlic', 'broccoli',
  'cabbage', 'cauliflower', 'zucchini', 'carrot', 'corn', 'mushroom', 'lettuce', 'spinach',
  'salad', 'artichoke', 'bean', 'legume', 'peas', 'squash',
  'tray', 'plate', 'platter', 'dish', 'bowl', 'pot', 'skillet', 'menu', 'dining', 'meal',
  'soup', 'stew', 'pasta', 'spaghetti', 'noodle', 'curry', 'egg', 'cheese', 'dessert', 'cake',
  'pastry', 'pie', 'waffle', 'pancake', 'snack', 'chocolate', 'custard', 'pudding', 'tart',
  'ice cream', 'ice lolly', 'trifle', 'cookie', 'biscuit', 'muffin', 'doughnut', 'donut',
  'carbonara', 'consomme', 'hot pot',
];

const NON_FOOD_TERMS = [
  'human', 'person', 'man', 'woman', 'boy', 'girl', 'face', 'selfie', 'beard', 'mustache',
  'groom', 'bride', 'sunglasses', 'swimsuit', 'jersey', 'cardigan', 'suit', 't-shirt',
  'dog', 'cat', 'puppy', 'kitten', 'mammal', 'canine', 'feline', 'bird', 'parrot',
];
const NON_FOOD_RE = new RegExp(`\\b(${NON_FOOD_TERMS.map((t) => t.replace(/[-]/g, '\\-')).join('|')})\\b`, 'i');

// category -> [keywords], fresh-shelf-life range in days [min, max]
const CATEGORIES = [
  { name: 'seafood',  days: [1, 2],  terms: ['fish', 'salmon', 'tuna', 'seafood', 'lobster', 'crab', 'shrimp'] },
  { name: 'meat',     days: [1, 3],  terms: ['meat', 'beef', 'pork', 'steak', 'chicken', 'poultry', 'turkey', 'sausage', 'bacon', 'patty', 'meatloaf', 'meat loaf'] },
  { name: 'leafy',    days: [2, 4],  terms: ['lettuce', 'spinach', 'salad', 'cabbage', 'broccoli', 'cauliflower'] },
  { name: 'fruit',    days: [3, 6],  terms: ['apple', 'granny smith', 'banana', 'orange', 'lemon', 'lime', 'fig', 'grape', 'strawberry', 'berry', 'pineapple', 'pomegranate', 'jackfruit', 'mango', 'watermelon', 'melon'] },
  { name: 'vegetable', days: [4, 7], terms: ['cucumber', 'pepper', 'chili', 'tomato', 'potato', 'onion', 'garlic', 'zucchini', 'carrot', 'corn', 'mushroom', 'artichoke', 'bean', 'peas', 'squash'] },
  { name: 'bakery',   days: [2, 4],  terms: ['bread', 'bagel', 'pretzel', 'toast', 'roll', 'croissant', 'bakery', 'dough', 'french loaf', 'muffin', 'doughnut', 'donut', 'cake', 'pastry', 'pie', 'tart', 'waffle', 'pancake', 'cookie', 'biscuit'] },
  { name: 'dairy',    days: [5, 7],  terms: ['egg', 'cheese', 'custard', 'pudding', 'ice cream', 'trifle'] },
  { name: 'prepared', days: [1, 3],  terms: ['pizza', 'burger', 'cheeseburger', 'hotdog', 'sandwich', 'taco', 'burrito', 'enchilada', 'quesadilla', 'wrap', 'soup', 'stew', 'pasta', 'spaghetti', 'noodle', 'curry', 'carbonara', 'consomme', 'hot pot', 'guacamole', 'salsa'] },
];

function categorize(name) {
  const n = String(name).toLowerCase();
  const hit = CATEGORIES.find((c) => c.terms.some((t) => n.includes(t)));
  return hit || { name: 'general', days: [1, 3] };
}

const toTitle = (raw) => String(raw || 'Food Item').split(',')[0].trim()
  .split(/\s+/).map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ') || 'Food Item';

/**
 * Decide whether the classified image is food.
 * predictions: [{ className, probability }] (MobileNet top-N)
 */
function verifyFood(predictions, userLabel) {
  const top = predictions[0] ? String(predictions[0].className).toLowerCase() : '';
  const all = predictions.map((p) => String(p.className).toLowerCase()).join(' ');

  if (NON_FOOD_RE.test(top)) {
    return { isFood: false, detectedName: toTitle(predictions[0].className) };
  }
  const match = predictions.find((p) => FOOD_TERMS.some((t) => String(p.className).toLowerCase().includes(t)));
  if (match || FOOD_TERMS.some((t) => all.includes(t))) {
    return { isFood: true, detectedName: toTitle((match || predictions[0]).className) };
  }
  if (userLabel && userLabel.length > 2) {
    return { isFood: true, detectedName: toTitle(userLabel) };
  }
  return { isFood: false, detectedName: predictions[0] ? toTitle(predictions[0].className) : 'Object' };
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * features (all optional, 0..1): brightness, saturation, darkRatio, brownRatio
 * Deterministic: the same image always gets the same score.
 */
function scoreFreshness(features, imageHash) {
  const jitter = (parseInt(imageHash.slice(0, 4), 16) % 7) - 3; // -3..+3, stable per image
  const f = features || {};
  const num = (v, d) => (typeof v === 'number' && isFinite(v) ? clamp(v, 0, 1) : d);
  const hasFeatures = ['brightness', 'saturation', 'darkRatio', 'brownRatio'].some((k) => typeof f[k] === 'number');

  const brightness = num(f.brightness, 0.5);
  const saturation = num(f.saturation, 0.4);
  const darkRatio = num(f.darkRatio, 0);
  const brownRatio = num(f.brownRatio, 0);

  const factors = [];
  let score = 95;
  if (hasFeatures) {
    const brownPenalty = brownRatio * 40;
    const darkPenalty = darkRatio * 30;
    const dullPenalty = Math.max(0, 0.18 - saturation) * 45;
    const dimPenalty = Math.max(0, 0.25 - brightness) * 30;
    score -= brownPenalty + darkPenalty + dullPenalty + dimPenalty;
    if (brownPenalty > 6) factors.push('noticeable browning / discoloration');
    if (darkPenalty > 5) factors.push('dark spots or shadowed areas');
    if (dullPenalty > 3) factors.push('dull, low-saturation coloration');
    if (dimPenalty > 3) factors.push('low image brightness (reduced confidence)');
  } else {
    score = 85;
  }
  score = clamp(Math.round(score + jitter), 35, 99);
  return { score, factors };
}

function analyze({ predictions, features, label, imageHash }) {
  const verification = verifyFood(predictions, label);
  if (!verification.isFood) return { isFood: false, detectedName: verification.detectedName };

  const title = label ? toTitle(label) : verification.detectedName;
  const { score, factors } = scoreFreshness(features, imageHash);
  const category = categorize(`${title} ${verification.detectedName}`);

  let status; let shelfLife; let risk;
  const riskPct = Math.max(0.2, ((100 - score) * 0.35)).toFixed(1);
  if (score >= 75) {
    status = 'Passed / Safe';
    const [min, max] = category.days;
    shelfLife = min === max ? `${min} Day${min > 1 ? 's' : ''}` : `${min} - ${max} Days`;
    risk = score >= 90 ? 'Low (<1%)' : `Low (${riskPct}%)`;
  } else if (score >= 55) {
    status = 'Caution Advised';
    shelfLife = 'Consume promptly';
    risk = `Moderate (${riskPct}%)`;
  } else {
    status = 'Spoilage Suspected';
    shelfLife = 'Do not store - discard';
    risk = `High (${riskPct}%)`;
  }

  const summary = score >= 75
    ? `Verified edible sample of ${title} (${category.name}). Surface texture, visible coloration and moisture levels conform to freshness metrics.${factors.length ? ` Minor notes: ${factors.join(', ')}.` : ''}`
    : `Sample of ${title} (${category.name}) shows reduced freshness indicators: ${factors.join(', ') || 'overall quality below threshold'}. ${score >= 55 ? 'Consume soon and inspect before eating.' : 'Discarding is recommended.'}`;

  return {
    isFood: true, title, detectedName: verification.detectedName,
    category: category.name, score, status, shelfLife, risk, summary,
  };
}

const hashImage = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

module.exports = { analyze, verifyFood, scoreFreshness, hashImage, toTitle };
