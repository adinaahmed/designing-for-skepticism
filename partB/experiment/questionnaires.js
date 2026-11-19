/* Questionnaires (Phase 2 methodology, Step 2).
   GAAIS: Schepman & Rodway (2020), 20 items, 5-point scale; items 13–20 = negative subscale (reverse-scored).
   Berlin Numeracy Test: Cokely et al. (2012), traditional 4-item version; answers 30, 25, 20, 50.
   Trust in Automation: Jian, Bisantz & Drury (2000), 12 items, 7-point scale (1 = not at all, 7 = extremely);
   items 1–5 measure distrust (reverse-scored). "the system" is worded as "the AI" for this study.
   Not used in the final short version (README decisions 20–21); kept for reference. */

const GAAIS_INTRO =
  "We are interested in your attitudes towards Artificial Intelligence. By Artificial Intelligence we mean " +
  "devices that can perform tasks that would usually require human intelligence. Please note that these can be " +
  "computers, robots or other hardware devices, possibly augmented with sensors or cameras, etc. Please complete " +
  "the following scale, indicating your response to each item.";
const GAAIS_LABELS = ["Strongly disagree", "Somewhat disagree", "Neutral", "Somewhat agree", "Strongly agree"];
const GAAIS_ITEMS = [
  // positive subscale (1–12)
  "I am interested in using artificially intelligent systems in my daily life",
  "There are many beneficial applications of Artificial Intelligence",
  "Artificial Intelligence is exciting",
  "Artificial Intelligence can provide new economic opportunities for this country",
  "I would like to use Artificial Intelligence in my own job",
  "An artificially intelligent agent would be better than an employee in many routine jobs",
  "I am impressed by what Artificial Intelligence can do",
  "Artificial Intelligence can have positive impacts on people's wellbeing",
  "Artificially intelligent systems can help people feel happier",
  "Artificially intelligent systems can perform better than humans",
  "Much of society will benefit from a future full of Artificial Intelligence",
  "For routine transactions, I would rather interact with an artificially intelligent system than with a human",
  // negative subscale (13–20)
  "I think Artificial Intelligence is dangerous",
  "Organisations use Artificial Intelligence unethically",
  "I find Artificial Intelligence sinister",
  "Artificial Intelligence is used to spy on people",
  "I shiver with discomfort when I think about future uses of Artificial Intelligence",
  "Artificial Intelligence might take control of people",
  "I think artificially intelligent systems make many errors",
  "People like me will suffer if Artificial Intelligence is used more and more",
];

const BNT_ITEMS = [
  { name: "bnt1", answer: 30, unit: "out of 50 throws",
    text: "Imagine we are throwing a five-sided die 50 times. On average, out of these 50 throws how many times would this five-sided die show an odd number (1, 3 or 5)?" },
  { name: "bnt2", answer: 25, unit: "%",
    text: "Out of 1,000 people in a small town 500 are members of a choir. Out of these 500 members in the choir 100 are men. Out of the 500 inhabitants that are not in the choir 300 are men. What is the probability that a randomly drawn man is a member of the choir? Please indicate the probability in percent." },
  { name: "bnt3", answer: 20, unit: "out of 70 throws",
    text: "Imagine we are throwing a loaded die (6 sides). The probability that the die shows a 6 is twice as high as the probability of each of the other numbers. On average, out of these 70 throws how many times would the die show the number 6?" },
  { name: "bnt4", answer: 50, unit: "%",
    text: "In a forest 20% of mushrooms are red, 50% brown and 30% white. A red mushroom is poisonous with a probability of 20%. A mushroom that is not red is poisonous with a probability of 5%. What is the probability that a poisonous mushroom in the forest is red?" },
];

const TIA_LABELS = ["1<br>Not at all", "2", "3", "4", "5", "6", "7<br>Extremely"];
const TIA_ITEMS = [
  "The AI is deceptive",
  "The AI behaves in an underhanded manner",
  "I am suspicious of the AI's intent, action, or outputs",
  "I am wary of the AI",
  "The AI's actions will have a harmful or injurious outcome",
  "I am confident in the AI",
  "The AI provides security",
  "The AI has integrity",
  "The AI is dependable",
  "The AI is reliable",
  "I can trust the AI",
  "I am familiar with the AI",
];
