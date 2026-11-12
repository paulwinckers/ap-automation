import type { Course, Video } from './types';

const V: Record<string, Video> = {
  nail:    { id: '-4EDhdAHrOg', url: 'https://youtu.be/-4EDhdAHrOg', title: "It's Not About the Nail", meta: '1:42 · Jason Headley', why: 'She wants to be heard. He wants to fix it.' },
  brain:   { id: '-bSGvvGR-rU', url: 'https://youtu.be/-bSGvvGR-rU', title: 'How Your Emotional Brain Works', meta: '3:01 · SYNEA Method', why: 'Why emotions take over before reason catches up.' },
  brene:   { id: '1Evwgu369Jw', url: 'https://youtu.be/1Evwgu369Jw', title: 'Brené Brown on Empathy', meta: '2:53 · RSA', why: 'Empathy ("I get it") vs. sympathy ("at least…").' },
  sinek:   { id: 'iIahC1BRYyU', url: 'https://youtu.be/iIahC1BRYyU?t=39', title: 'The Secret to Outstanding Customer Service', meta: '3:00, start at 0:39 · Simon Sinek', why: 'Make people feel cared for, not just served.' },
  pollack: { id: 'KvHi2trFlpo', url: 'https://youtu.be/KvHi2trFlpo', title: 'De-escalation Skills Training', meta: '5:51 · Dr. Jeremy Pollack', why: 'Practical ways to calm a tense conversation.' },
};

export const difficultCustomers: Course = {
  id: 'difficult-customers',
  title: 'Handling Difficult Customers',
  summary: 'Calming upset customers and neighbours, and who to call when you can\'t fix it yourself.',
  audience: 'Crew leads',
  pocketCard: [
    { title: 'LAST', ordered: true, items: [
      'Listen: stop, face them, let them finish',
      'Acknowledge: "I can see why that\'s frustrating"',
      'Solve: fix it, or say who calls and when',
      'Thank: then log it in Aspire',
    ] },
    { title: 'Who to call', ordered: true, items: [
      'Crew lead: on site',
      'Becca or Don: quality and scope',
      'Vesna or Jim: damage, billing, neighbours; major accounts go to Vesna',
      'Paul: legal, insurance, safety, unresolved',
    ] },
    { title: 'Walk away if', items: [
      'Anyone is yelling, swearing or threatening',
      'A crew member or truck is blocked in',
      'Stop, leave, then call your manager',
    ] },
  ],
  modules: [
    {
      id: 'why', title: 'Why people get difficult', mins: 5,
      lede: 'Most upset customers aren\'t bad people. They\'re frustrated, and usually for a reason we can do something about.',
      blocks: [
        { kind: 'videos', videos: [V.nail] },
        { kind: 'text', paragraphs: [
          'Watch the video first. The joke lands because we\'ve all been him: someone tells us a problem and we jump straight to the fix. On a job site, the complaint a customer says out loud is often not the whole problem. If you go straight to the fix, they feel brushed off, even when your fix is right.',
        ] },
        { kind: 'cards', title: 'Four reasons people get upset', cards: [
          { title: 'It\'s their home', text: 'Their yard is personal. A small scuff or brown patch can feel big.' },
          { title: 'Expectations missed', text: 'They pictured something different from what was sold or scheduled.' },
          { title: 'They felt ignored', text: 'Unanswered calls or surprise visits make people angry fast.' },
          { title: 'A bad day', text: 'Sometimes it isn\'t about us at all. Don\'t take it personally.' },
        ] },
        { kind: 'callout', label: 'Think about it:', text: 'which of these do we cause ourselves? Usually missed expectations and feeling ignored. Good communication prevents both.' },
      ],
      checks: [
        { q: 'A customer is upset about a small brown patch by the driveway. What\'s most likely going on?',
          options: ['They\'re just a difficult person.', 'It\'s their home, so a small problem feels big to them.', 'They\'re angling for a discount.'],
          correct: 1, explain: 'Start from the assumption that they care about their property. That keeps you calm and curious instead of defensive.' },
      ],
    },
    {
      id: 'brain', title: 'The angry brain', mins: 5,
      lede: 'When someone is angry, the emotional part of the brain reacts before the thinking part catches up.',
      blocks: [
        { kind: 'videos', videos: [V.brain] },
        { kind: 'text', paragraphs: [
          'While someone is in that state, facts, prices and explanations don\'t land. Arguing back, correcting them or explaining just adds fuel.',
          'What brings the thinking brain back is feeling heard. Stay calm, let them vent and acknowledge how they feel. Once they\'ve cooled down, they can take in a solution.',
          'The same goes for you. If you feel your own temper rising, step away for a minute before you answer.',
        ] },
        { kind: 'callout', label: 'The rule:', text: 'calm them first, reason second.' },
      ],
      checks: [
        { q: 'A customer is yelling about a bed edge they say was missed. When should you explain what the crew actually did?',
          options: ['Right away, so they have the facts.', 'After they\'ve calmed down and feel heard.', 'Never. Just pack up and leave.'],
          correct: 1, explain: 'Facts don\'t land while emotions are running the show. Listen and acknowledge first, then explain.' },
      ],
    },
    {
      id: 'last', title: 'On site, use LAST', mins: 5,
      lede: 'Four steps for any upset customer: Listen, Acknowledge, Solve, Thank.',
      blocks: [
        { kind: 'cards', cards: [
          { big: 'L', title: 'Listen', text: 'Stop work, take off sunglasses and ear protection, and face them. Let them finish.' },
          { big: 'A', title: 'Acknowledge', text: '"I can see why that\'s frustrating." Say sorry for the experience, even before you know who\'s at fault.' },
          { big: 'S', title: 'Solve', text: 'Fix it now if it\'s in your power. If not, say exactly who will call and by when.' },
          { big: 'T', title: 'Thank', text: '"Thanks for telling me directly." Then follow through and log it in Aspire.' },
        ] },
        { kind: 'text', paragraphs: [
          'Listening is the step we skip most. Acknowledging is not admitting fault: "I\'m sorry this happened" is different from "we broke it."',
          'Never promise credits, refunds or free work on site unless that\'s within your authority. Promise a call-back with a time instead.',
        ] },
      ],
      checks: [
        { q: 'What does the A in LAST mean on site?',
          options: ['Argue your side, politely.', 'Acknowledge: show you understand, even before you know who\'s at fault.', 'Ask them to call the office.'],
          correct: 1, explain: 'Acknowledging how they feel is what lets them calm down. It isn\'t the same as admitting fault.' },
        { q: 'A customer asks for a credit for a damaged plant. You aren\'t sure you\'re allowed to give one. What do you say?',
          options: ['"Sure, I\'ll take it off your bill."', '"I\'ll have the account manager call you by 3 today to sort that out."', '"Credits aren\'t my problem."'],
          correct: 1, explain: 'Give a specific person and a specific time. Don\'t promise what you can\'t approve.' },
      ],
    },
    {
      id: 'empathy', title: 'Empathy beats a quick fix', mins: 9,
      lede: 'People remember how you made them feel, not just whether the problem got fixed.',
      blocks: [
        { kind: 'videos', videos: [V.brene, V.sinek] },
        { kind: 'compare', title: 'Words that cool things down',
          no:  { title: 'Pours fuel on it', items: ['"That\'s not my job."', '"Calm down."', '"You\'ll have to call the office."', '"The other guys did that."', '"It\'ll grow back."'] },
          yes: { title: 'Say this instead', items: ['"Let me find out for you."', '"I can see this matters to you."', '"I\'ll have the manager call you by 3 today."', '"Let me take a look and get photos."', '"Let\'s get it fixed properly."'] } },
        { kind: 'callout', label: 'Watch for "at least…":', text: '"At least it\'s only one shrub" sounds helpful but tells the customer their worry doesn\'t count.' },
      ],
      checks: [
        { q: 'A customer says the new shrub you planted looks like it\'s dying. Which response is best?',
          options: ['"It\'ll grow back."', '"At least it\'s only one."', '"Let me take a look and get photos so we can sort it out."'],
          correct: 2, explain: 'It takes their concern seriously and moves toward a fix. The other two brush it off.' },
      ],
    },
    {
      id: 'neighbours', title: 'Neighbours', mins: 4,
      lede: 'Neighbours aren\'t our customer, but they are our reputation. They\'re also tomorrow\'s customers.',
      blocks: [
        { kind: 'cards', cards: [
          { title: 'Noise before 7 a.m.', text: 'No loud equipment before 7. Save the noisiest work for later.' },
          { title: 'Blocked driveways', text: 'Never block driveways, mailboxes or sidewalks with trucks or trailers.' },
          { title: 'Mess on their side', text: 'Blow off clippings, dust and debris from their walk and drive before you leave.' },
          { title: 'Property lines', text: 'Fence, tree and boundary disputes. Never settle these on site.' },
        ] },
        { kind: 'list', title: 'How we handle it', items: [
          'Be friendly and listen. LAST works with neighbours too.',
          'Fix what\'s ours right away: move the truck, blow off their walk.',
          'Never discuss our customer, their property or their price.',
          'Never take sides on property lines or fences. If a neighbour says you\'re on their property, stop that part of the work.',
          'Get their name and number. Neighbour complaints go to Vesna or Jim the same day.',
        ] },
      ],
      checks: [
        { q: 'A neighbour asks how much our customer is paying for their new patio. What do you say?',
          options: ['Give them a rough number.', '"I can\'t share our customer\'s details, but I\'m happy to pass your number along for a quote."', 'Ignore them and keep working.'],
          correct: 1, explain: 'Protect the customer\'s privacy and still treat the neighbour as a possible customer.' },
      ],
    },
    {
      id: 'deescalate', title: 'De-escalation skills', mins: 8,
      lede: 'Practical ways to keep a tense conversation from blowing up.',
      blocks: [
        { kind: 'videos', videos: [V.pollack] },
        { kind: 'list', title: 'What to do with your voice and body', items: [
          'Lower your voice and slow down. People tend to match the tone you set.',
          'Keep a comfortable distance and keep your hands visible.',
          'Repeat back what you heard: "So the back bed wasn\'t edged and you were expecting it today."',
          'Set a calm boundary if needed: "I want to help. I can\'t do that while we\'re shouting."',
        ] },
      ],
      checks: [
        { q: 'Which of these lowers the temperature fastest?',
          options: ['Matching their volume so they know you\'re serious.', 'Lowering your voice and slowing down.', 'Telling them to calm down.'],
          correct: 1, explain: 'People tend to match your tone. "Calm down" almost always makes it worse.' },
      ],
    },
    {
      id: 'escalate', title: 'How we escalate', mins: 5,
      lede: 'If you can\'t settle it, hand it up the ladder. Tell the customer who will call them and when.',
      blocks: [
        { kind: 'ladder', rungs: [
          { level: '1', who: 'Crew lead', role: 'On site · right away', text: 'Use LAST. Fix small issues within your authority (re-blow, re-edge, re-plant). Take photos.' },
          { level: '2', who: 'Becca or Don', role: 'Field Supervisor · same day', text: 'Quality or scope issues the lead can\'t settle. A supervisor calms things down and fixes it, on site during the visit or by phone.' },
          { level: '3', who: 'Vesna or Jim', role: 'Account Manager · same day', text: 'Not settled by the supervisor, property damage, billing, any neighbour complaint. Vesna (also an owner) approves credits and redos and handles major accounts at risk.' },
          { level: '4', who: 'Paul', role: 'GM and owner · within 24 hours', text: 'Not resolved at level 3, repeat complaints, legal threats, insurance claims, safety incidents.' },
        ] },
        { kind: 'callout', label: 'Every step:', text: 'log it as an Issue in Aspire with photos, and tell the customer who will call them and when. Save Becca\'s and Don\'s numbers, and know whether your accounts sit with Vesna or Jim.' },
      ],
      checks: [
        { q: 'A customer says the crew didn\'t do the work they asked for, and you can\'t sort it out. Who do you call first?',
          options: ['Becca or Don', 'Vesna or Jim', 'Paul'],
          correct: 0, explain: 'That\'s a scope question, so it goes to a field supervisor first.' },
        { q: 'A long-time major customer tells you they\'re thinking of cancelling. Who handles it?',
          options: ['Becca or Don', 'Vesna', 'Paul'],
          correct: 1, explain: 'Major accounts at risk go to Vesna.' },
        { q: 'A customer threatens to sue over damage to their car. Where does it end up?',
          options: ['Level 2, a field supervisor', 'Level 3, an account manager', 'Level 4, Paul'],
          correct: 2, explain: 'Legal threats and insurance claims go to Paul.' },
      ],
    },
    {
      id: 'walkaway', title: 'When to walk away', mins: 3,
      lede: 'No job is worth a fight. Skip the ladder if anyone is yelling, swearing, threatening, or blocking a crew member or vehicle.',
      blocks: [
        { kind: 'cards', cards: [
          { title: '1. Stay calm', text: 'Lower your voice, keep your distance, keep your hands visible.' },
          { title: '2. Stop work and leave', text: 'Pull the crew back to the trucks. The job can wait.' },
          { title: '3. Call your manager', text: 'Right away, from the truck. Call 911 if anyone is in danger.' },
          { title: '4. Write it down', text: 'What was said, the time, any witnesses. Photos or video only if it\'s safe.' },
        ] },
        { kind: 'callout', tone: 'danger', label: 'You will never get in trouble', text: 'for stopping work and leaving a site when someone is aggressive. Don\'t argue, don\'t film in someone\'s face, and don\'t touch anyone\'s property in anger.' },
      ],
      checks: [
        { q: 'A customer starts swearing and steps toward one of your crew. What do you do first?',
          options: ['Finish the job quickly, then leave.', 'Stop work, pull the crew back to the trucks and call your manager.', 'Stand your ground so they know you won\'t be pushed around.'],
          correct: 1, explain: 'Safety comes first. Leave, then call. The job can be finished another day.' },
      ],
    },
    {
      id: 'practice', title: 'Practice scenarios', mins: 6,
      lede: 'Three situations from real job sites. Pick the best first move for each.',
      blocks: [
        { kind: 'text', paragraphs: ['For each one, think about what you\'d say first, what you could fix on the spot, and which level it goes to. Then pick an answer.'] },
      ],
      checks: [
        { tag: 'Scenario 1 · Not what I asked for', q: 'A customer storms out: "You didn\'t do the work I asked for. I\'m not paying for this." What\'s your best first move?',
          options: ['Explain that the work order is what it is and they\'ll still be billed.', 'Listen to exactly what they expected, check the work order in Aspire, take photos, and call Becca or Don.', 'Tell them to call the office and keep working.'],
          correct: 1, explain: 'It\'s a scope question, so it goes to a field supervisor during the visit. Don\'t argue about payment; that goes to Vesna or Jim.' },
        { tag: 'Scenario 2 · Pruned wrong?', q: 'Watching from the porch, a customer says you\'re cutting their hydrangea wrong and it won\'t bloom next year. What do you do?',
          options: ['Keep going. You know what you\'re doing.', 'Stop pruning that plant and listen. Explain if you\'re sure; if not, pause and call Becca or Don.', 'Agree with whatever they say so they go back inside.'],
          correct: 1, explain: 'It\'s a quality question. Don\'t argue about pruning on the spot. Note what they want in Aspire so the next crew gets it right.' },
        { tag: 'Scenario 3 · That\'s my tree', q: 'Mid-pruning, the neighbour says the tree is on their side and you need to stop. What do you do?',
          options: ['Finish the cut. Our customer asked for it.', 'Stop that part of the work, don\'t argue the line, get their contact info and call Becca or Don.', 'Show them where you think the property line is.'],
          correct: 1, explain: 'Never settle property lines on site. It goes to a supervisor and the account manager, and to Paul if it becomes a legal or insurance matter.' },
      ],
    },
  ],
};
