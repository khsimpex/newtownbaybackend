/**
 * Scope guard for the concierge bot.
 *
 * The bot answers about this shop only: orders, products, delivery, returns,
 * payments, invoices, sizing, promotions, and reaching human care. Anything else
 * — general knowledge, coding help, homework, news, medical or legal advice,
 * other shops — is refused.
 *
 * Two layers, because neither is enough alone:
 *   1. `offTopicReason` — deterministic, runs BEFORE any model call, so obvious
 *      off-topic asks cost nothing and cannot be argued with.
 *   2. A prompt rule that makes the model answer with the `OUT_OF_SCOPE`
 *      sentinel for anything pattern-matching cannot catch; `SCOPE_REPLY` is
 *      substituted server-side.
 *
 * Layer 1 is deliberately narrow. It blocks what is unambiguously outside the
 * shop, and lets everything else through to the model rather than guessing: a
 * wrongly blocked order complaint is worse than a wasted model call.
 */

/** What the customer is told when a question is out of scope. */
export const SCOPE_REPLY =
  "I can only help with Newtownbay orders, products, delivery, returns, payments and account questions — " +
  "I don't answer anything outside the store. 🤍\n\n" +
  "If your question is about an order or a piece, tell me the Order ID (e.g. NTB-…) and I'll pick it up. " +
  "For anything else, 'Chat to Customer Care' reaches our team.";

/** Model returns exactly this when the question is outside the shop. */
export const OUT_OF_SCOPE = "OUT_OF_SCOPE";

type Rule = { name: string; pattern: RegExp; decisive?: boolean };

/**
 * Unambiguously outside the shop. Ordered roughly by how often each shows up in
 * real support inboxes.
 */
const OFF_TOPIC_RULES: Rule[] = [
  {
    name: "coding",
    pattern:
      /\b(write|debug|fix|refactor|explain|generate|review)\b[^.]{0,40}\b(code|script|function|program|regex|sql|python|javascript|java|c\+\+|html|css|api|app|website|excel formula)\b|\b(python|javascript|typescript|c\+\+|java|react|node|npm|git|docker|kubernetes|sql query|leetcode)\b/i,
  },
  {
    name: "homework",
    pattern: /\b(homework|assignment|essay|thesis|dissertation|solve|equation|integral|derivative|calculus|algebra|physics|chemistry|biology)\b|\b\d+\s*[\+\-\*\/x×]\s*\d+\s*=/i,
  },
  {
    name: "general knowledge",
    pattern:
      /\b(who (is|was|are) (the )?(president|pm|prime minister|ceo|actor|actress|singer|player)|capital of|population of|translate|translation|meaning of|define|synonym|antonym|recipe|joke|poem|story|riddle|horoscope|astrology|zodiac|lottery|stock tips?|crypto|bitcoin|share market)\b/i,
  },
  {
    name: "news and world",
    pattern: /\b(news|headline|election|politics|political|religion|religious|war|weather|temperature|rain|cricket|match score|fifa|olympics)\b/i,
  },
  {
    name: "medical or legal",
    pattern:
      /\b(doctor|medicine|medicines|dosage|dose|tablet|capsule|antibiotic|paracetamol|ibuprofen|symptom|diagnos|disease|infection|treatment|fever|covid|illness|unwell|injur|painkiller|lawyer|legal advice|fir|police complaint|court case|visa|passport|tax filing|itr)\b/i,
  },
  {
    name: "other shops",
    // Decisive: naming a competitor means the customer is asking about somebody
    // else's catalogue, and the shop vocabulary in the same sentence ("cheaper
    // than amazon for shirts") does not make that our question to answer.
    decisive: true,
    pattern:
      /\b(compare|vs|versus|better than|cheaper than|discount on)\b[^.]{0,40}\b(amazon|flipkart|myntra|ajio|meesho|zara|h&m|uniqlo|nykaa|snapdeal|tata cliq|bewakoof|souled store|other (site|store|brand|website))\b|\b(amazon|flipkart|myntra|ajio|meesho|zara|h&m|uniqlo|nykaa|snapdeal)\b/i,
  },
  {
    name: "unrelated task",
    pattern:
      /\b(write|draft|compose|make|create|build)\b[^.]{0,30}\b(email|resume|cv|cover letter|report|presentation|ppt|invoice template|logo|poster|bio|tweet|caption|blog)\b(?!\s*(for|of|about)\s*(my|the)\s*(order|return|refund|exchange|replacement|piece|product|size))/i,
  },
  {
    name: "prompt or identity probing",
    pattern:
      /\b(ignore|forget|disregard)\b[^.]{0,30}\b(instruction|rule|prompt|guideline)s?\b|\b(system prompt|your (instructions|prompt|guidelines|rules)|jailbreak|developer mode|dan mode|act as|pretend to be|roleplay|chatgpt|openai|gpt-?\d|which (llm|model|ai) (are|is) you|are you (an? )?(ai|bot|robot|human)|your (api|key|token))\b|\brepeat (everything|your|the) above\b/i,
  },
  {
    name: "off-site topics",
    pattern: /\b(crypto|nft|trading|forex|betting|casino|loan|insurance|job opening|hiring|franchise|fabrication|wholesale supplier)\b/i,
  },
];

/**
 * The shop's own vocabulary. A message that mentions any of it is in scope even
 * if it also trips a rule above, so "the size of my order" and "correct the
 * address on order NTB-123" are never refused.
 *
 * A rule marked `decisive` outranks this list, so naming a competitor is refused
 * even when our own product words appear in the same sentence.
 *
 * "Size" is deliberately absent: on its own it is ambiguous, and the sizing rule
 * already covers the shop sense. So are "model" and "look", which trip the
 * identity-probing rule or scope in unrelated questions.
 */
const SHOP_TERMS =
  /\b(order|orders|ord|track|tracking|awb|shipment|parcel|courier|deliver|delivered|delivery|dispatch|cancel|cancelled|cancellation|refund|refunded|return|returns|exchange|swap|replacement|replace|store credit|money back|payment|paid|pay|upi|razorpay|card|netbanking|wallet|cod|invoice|bill|billing|gst|receipt|coupon|promo|discount|voucher|offer|stock|sku|price|pricing|fabric|cotton|gsm|stitch|stitching|fit|oversized|boxy|chest|shoulder|length|measurement|chart|wash|care|iron|shrink|damage|damaged|defective|torn|stain|ntb-|order_|dashboard|checkout|cart|account|login|otp|address|pincode|delhivery|blue ?dart|hoodie|hoodies|tee|tees|t-shirt|tshirt|shirt|shirts|pant|pants|trouser|trousers|jeans|jacket|dress|kurta|sweatshirt|piece|pieces|collection|drop|arrival|lookbook|outfit|apparel|clothing|garment)\b/i;

/**
 * Returns the matched rule name when a message is unambiguously outside the
 * shop, otherwise null. The name is for logs only.
 */
export function offTopicReason(message: string): string | null {
  const text = message.toLowerCase().trim();
  if (text.length === 0) return null;

  // Decisive rules run first, before the shop-vocabulary rescue below.
  for (const rule of OFF_TOPIC_RULES) {
    if (rule.decisive && rule.pattern.test(text)) return rule.name;
  }

  // Shop vocabulary anywhere in the message keeps it in scope.
  if (SHOP_TERMS.test(text)) return null;

  for (const rule of OFF_TOPIC_RULES) {
    if (rule.pattern.test(text)) return rule.name;
  }
  return null;
}
