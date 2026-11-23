/**
 * Winter operations safety — one course per winter Safe Work Procedure (SWP-16 … SWP-20).
 * Lessons follow the SWP text in the Safety Program library (/ops/safety-program, doc ids 22–26).
 * If an SWP is revised, update the matching course here AND its module ids in backend
 * app/api/training.py COURSES.
 *
 * Videos are optional help. Every video id was checked live on YouTube (oEmbed) on 2026-11-22.
 * Many are US or general-audience videos: where one differs from our SWP or the operator's
 * manual, the SWP and the manual win (each course says so in module 1).
 */
import type { Block, Course, Video } from './types';

const yt = (id: string, title: string, meta: string, why: string, start?: number): Video =>
  ({ id, url: `https://youtu.be/${id}${start ? `?t=${start}` : ''}`, title, meta, why });

const V = {
  // SWP-16 sidewalks
  simaBlow:    yt('yzAp9cI_9ZE', 'Safety Tips for Commercial Snow Blowing', '2:54 · SIMA', 'Commercial-crew snowblower habits: chute direction, clogs, people nearby.'),
  clog:        yt('GKE3PsDC_kw', 'How to Safely Clean a Clogged Snow Blower', '3:47 · Inside Edition', 'Shows why hands never go in the chute, even with the engine off.'),
  simaShovel:  yt('Hsoe8r7Uehs', 'Commercial-Grade Shoveling Safety', '0:59 · SIMA', 'Push, don\'t throw. Small loads, legs not back.'),
  simaPush:    yt('DWVMaOSVQwo', 'Safe Use of Push and Wheeled Snow Shovels', '0:55 · SIMA', 'Using pushers without wrecking your back.'),
  penguin:     yt('LHaWGibGwyk', 'Walk Like a Penguin to Prevent Falls', '1:38 · Alberta Health Services', 'The short-step, flat-foot walk for icy ground.'),
  simaWalk:    yt('HDYPzZSYNmw', 'Walking Safely on Snow and Ice', '1:28 · SIMA', 'Footing, traction aids and three points of contact.'),
  simaSite:    yt('tpcih8omVyc', 'Site-Specific Sidewalk Safety Concerns', '1:26 · SIMA', 'Spotting the hazards each site hides under snow.'),
  simaDeicer:  yt('maByq6Ka-ko', 'Chemical Deicer Safety for Snow Professionals', '2:13 · SIMA', 'Gloves, eyes and the SDS when handling ice melt and brine.'),
  coldStress:  yt('9RA1zjVgJdQ', 'Toolbox Talk: Cold Stress', '9:17 · Construction Safety Association of Manitoba', 'Canadian toolbox talk on frostbite, hypothermia and warm-up breaks.'),
  coSmall:     yt('aLDvPGSXzrU', 'Carbon Monoxide from Portable Gas-Powered Equipment', '4:11 · US Department of Labor', 'How fast small engines fill an enclosed space with CO.'),
  // SWP-17 brine
  mainroad:    yt('oTl3JufR278', 'Liquid Anti-Icing Brine Program: Brine vs Granular Salt', '4:10 · Mainroad Group (BC)', 'A BC highway contractor explains how and when brine works.'),
  iowaAnti:    yt('HZI_ZbWybIU', 'Anti-Icing and Deicing', '7:39 · Iowa DOT Winter Operations Training', 'The difference between anti-icing before a storm and de-icing after.'),
  simaLiquid:  yt('DYK8rLC__us', 'Liquid Deicing for Sidewalk Snow Management', '1:23 · SIMA', 'Liquids on walkways: rates, coverage and slip risk.'),
  injection:   yt('aDq7jb-Ep8U', 'Understanding & Preventing Fluid Injection Injuries', '11:13 · International Fluid Power Society', 'Why a pinhole leak under pressure is a medical emergency.'),
  injectionFA: yt('NoieZWRntBA', 'High Pressure Injection Injuries', '5:28 · The First Aid Show', 'What an injection injury looks like and why it needs a hospital fast.'),
  // SWP-18 trucks
  plow101:     yt('ICCMJ9Es6n0', 'How to Snowplow with a Truck', '11:58 · Heavy Metal Learning', 'Truck plowing basics: blade angle, speed, stacking and pushing.'),
  simaBack:    yt('elw-4J-fyQc', 'Backing Up Safely', '3:48 · SIMA Snow Safety Week', 'Backing is where plow crews hit people and property.'),
  simaMount:   yt('ajYX7hc0ReI', 'Plow Attach & Detach Techniques', '2:28 · SIMA', 'Hooking up a plow without putting hands in pinch points.'),
  simaCab:     yt('MyVIFQDwM0k', 'Safely Entering and Exiting a Snow Removal Vehicle', '0:47 · SIMA', 'Three points of contact on icy steps.'),
  signals:     yt('E5-Gka2Gzjk', 'Backing Safety & Hand Signals', '3:37 · NC State Facilities', 'Spotter hand signals and where the spotter stands.'),
  // SWP-19 skid-steer
  bobcatSafe:  yt('fdyCQBc7bYg', 'Skid-Steer & Compact Track Loader Safety', '10:10 · Bobcat Company', 'The manufacturer\'s safety video: seat bar, ROPS, entry/exit, slopes.'),
  bobcatBlade: yt('m07UE4-tyFo', 'Trainer\'s Tips & Tricks: Snow Blade', '2:04 · Bobcat', 'A Bobcat trainer on running a snow blade.'),
  blindSpots:  yt('PlDnBQ3Iidw', 'Blind Spots & Spotter Safety', '4:02 · Colorado Division of Reclamation, Mining and Safety', 'How big a machine\'s blind spots really are.'),
  // SWP-20 driving
  clearCar:    yt('od43bamIhHo', '15 Seconds to Safety: Clear Your Entire Vehicle of Snow', '0:16 · BC Ministry of Transportation', 'Roof snow, lights and every window, every time.'),
  cbcWinter:   yt('lOmEKdBV1Rg', 'Tips and Tricks for Winter Driving', '6:13 · CBC British Columbia', 'BC-specific winter driving advice.'),
  crWinter:    yt('HIWVRbr15ek', 'Essential Winter Driving Tips', '2:54 · Consumer Reports', 'Smooth inputs, braking distance and skid recovery.'),
  blackIce:    yt('OjnRJ_PqKhQ', 'Winter Driving Tips on Black Ice', '3:10 · Smart Drive Test', 'Where black ice forms and how to drive over it.'),
  fatigue:     yt('SooPxUEUdlQ', 'Science of Sleep: Fatigue Effects on Driving', '1:01 · Road Safety Commission', 'Why tired driving is like impaired driving.'),
  stranded:    yt('uVcPKuD6iBI', 'Winter Car Survival: What to Do If You Get Stuck', '2:48 · Halfords', 'Staying with the vehicle, staying warm, keeping the exhaust clear.'),
  behindPlow:  yt('uffXIrvy7PU', 'Driving Safely Behind a Plow Truck', '1:28 · MaineDOT', 'What the public sees from behind your plow, and why they crowd you.'),
};

const help = (...videos: Video[]): Block => ({ kind: 'videos', title: 'Need a refresher? Optional videos', videos });

const swpNote = (code: string): Block => ({
  kind: 'callout', label: 'Our rules come first.',
  text: `This course teaches ${code}. The videos are extra help. Some are from the US or other companies, and where a video and our SWP or the machine's operator's manual disagree, follow the SWP and the manual. The full ${code} is in the field app under 📖 Safety Program.`,
});

const cold: Block = {
  kind: 'cards', title: 'Cold stress: know the signs', cards: [
    { title: 'Frostnip / frostbite', text: 'White or grey waxy skin, numbness, tingling. Fingers, toes, ears, nose and cheeks go first.' },
    { title: 'Early hypothermia', text: 'Shivering, clumsy hands, stumbling, "umbles": mumbling, fumbling, grumbling.' },
    { title: 'Serious hypothermia: call 911', text: 'Confusion, slurred speech, drowsiness, shivering that stops. Warm them gradually, no alcohol.' },
  ],
};

const coldCheck = {
  q: 'Your crewmate has been shovelling for two hours. They\'ve stopped shivering, they\'re slurring their words and seem confused. What do you do?',
  options: ['Good, they\'ve warmed up. Keep working.', 'Get them into a warm, dry place, remove wet clothing, warm them gradually and call 911.', 'Give them a coffee with a shot of something to warm up.'],
  correct: 1, explain: 'Confusion, slurred speech and shivering that stops are signs of serious hypothermia. That\'s a 911 call. Never give alcohol.',
};

const coCheck = {
  q: 'It\'s minus 12 and blowing. Can you start the snowblower (or idle the truck) inside the loading bay to warm it up?',
  options: ['Yes, if the big door is half open.', 'Yes, for a minute or two.', 'No. Start and run engines outdoors only.'],
  correct: 2, explain: 'Carbon monoxide builds up in minutes and you can\'t smell it. Headache, dizziness or nausea near a running engine means fresh air now.',
};

// ─────────────────────────────────────────────────────────────── SWP-16
export const winterSidewalks: Course = {
  id: 'winter-swp16-sidewalks',
  title: 'Winter: Sidewalk Snow & Ice (SWP-16)',
  summary: 'Snowblowers, shovelling and ice melt on walkways, steps and entrances, without getting hurt or hurting anyone.',
  audience: 'Maintenance and snow & ice crews',
  pocketCard: [
    { title: 'Before you start', ordered: true, items: [
      'Exits, accessible routes and stairs first',
      'Inspect the machine: guards, kill switch, chute',
      'Walk it: find curbs, grates, steps and hoses under the snow',
      'Fuel and start outdoors only',
    ] },
    { title: 'Never', items: [
      'Hands or feet in the chute or auger, even engine off',
      'Point the chute at people, windows, cars or roads',
      'Work through shivering, numbness or confusion',
    ] },
    { title: 'Clogged chute', ordered: true, items: [
      'Engine OFF',
      'Wait until everything stops',
      'Clearing tool only',
    ] },
  ],
  modules: [
    {
      id: 'plan', title: 'Plan the shift and dress for it', mins: 5,
      lede: 'Most winter injuries are decided before you leave the yard: what you\'re wearing, what you checked, and which walkways you do first.',
      blocks: [
        swpNote('SWP-16'),
        { kind: 'list', title: 'Before every call-out', items: [
          'Check the forecast, your site list and route. Your Supervisor sets the priorities.',
          'Life-safety routes come first: building exits, fire exits, accessible paths and stairs.',
          'Tell your Supervisor your route so someone knows where you are.',
          'Pack spare dry gloves, water and a charged phone. Plan your warm-up breaks.',
        ] },
        { kind: 'cards', title: 'PPE for sidewalk crews', cards: [
          { title: 'Feet', text: 'CSA steel-toe winter boots with real tread. Add ice cleats when it\'s icy.' },
          { title: 'Layers', text: 'Wicking base, warm middle, wind- and waterproof outer. Toque or hard-hat liner.' },
          { title: 'Be seen', text: 'Class 2 hi-vis minimum. Class 3 or added lights near roads or in the dark. Headlamp before dawn.' },
          { title: 'Hands, eyes, ears', text: 'Insulated waterproof gloves plus a spare pair, safety glasses, hearing protection on the blower.' },
        ] },
        help(V.simaSite),
      ],
      checks: [
        { q: 'You arrive at a site with a main entrance, a side fire exit, a staff smoking area and a long front walkway. What gets cleared first?',
          options: ['The long front walkway, since it\'s the most visible.', 'The main entrance and the fire exit.', 'Whatever is closest to the truck.'],
          correct: 1, explain: 'Exits, accessible routes and stairs are life-safety routes. They always come first.' },
      ],
    },
    {
      id: 'blower', title: 'Snowblower: the auger and the chute', mins: 6,
      lede: 'A snowblower can take a finger off in a split second, and it throws ice and rock hard enough to break a window.',
      blocks: [
        { kind: 'list', title: 'Inspect before you start', items: [
          'Guards in place, controls and kill switch working.',
          'Chute and auger undamaged, fuel topped up.',
          'Check it the way the operator\'s manual for that model says. A defective machine gets tagged out, not used.',
        ] },
        { kind: 'callout', tone: 'danger', label: 'Clogged chute:', text: 'shut the engine OFF, wait for every moving part to stop, then clear it with the clearing tool. Never your hand or foot. A jammed auger stores energy and can snap around when the clog comes free, even with the engine off.' },
        { kind: 'list', title: 'While you\'re blowing', items: [
          'Aim the chute away from people, windows, vehicles and roads, and re-aim it every time you turn.',
          'Assume the chute will throw ice and rock.',
          'Cone and sign the area if the public is around. Keep everyone out of the discharge path.',
        ] },
        help(V.simaBlow, V.clog),
      ],
      checks: [
        { q: 'The chute plugs with wet snow. The engine is idling and the auger is disengaged. What\'s the safe way to clear it?',
          options: ['Reach in quickly with a thick glove since the auger is off.', 'Kick the chute to knock the snow loose.', 'Shut the engine off, wait until everything stops, and use the clearing tool.'],
          correct: 2, explain: 'Most snowblower amputations happen with the auger "off". Engine off, wait, tool only.' },
        { q: 'You\'re clearing a walkway beside a parking lot with cars parked along it. Where should the chute point?',
          options: ['Toward the parked cars. It\'s only snow.', 'Away from the cars, people and building, onto open ground or the snow bank.', 'It doesn\'t matter if you\'re going slowly.'],
          correct: 1, explain: 'The chute throws ice and gravel. Aim it where nobody and nothing can be hit, and re-aim it as you turn.' },
      ],
    },
    {
      id: 'shovel', title: 'Shovelling, footing and ice melt', mins: 5,
      lede: 'Wet snow weighs a lot. Your back, your shoulders and your footing are what get hurt most on sidewalk crews.',
      blocks: [
        { kind: 'compare', title: 'Shovelling', no: { title: 'Gets you hurt', items: ['Lifting full loads of wet snow', 'Throwing over your shoulder', 'Twisting at the waist', 'Shovelling for an hour straight'] }, yes: { title: 'Do this', items: ['Push snow instead of lifting it where you can', 'Small loads, lift with your legs', 'Face the load, step to turn', 'Take micro-breaks and swap tasks'] } },
        { kind: 'text', title: 'Walk like a penguin', paragraphs: ['On ice, take short flat-footed steps with your weight over your front foot, arms out from your sides, and your hands out of your pockets. Use three points of contact getting in and out of the truck. Wear your ice cleats; that\'s what they\'re for.'] },
        { kind: 'list', title: 'Ice melt and sand', items: [
          'Follow the product label and the SDS. Gloves and eye protection on.',
          'Don\'t over-apply. Keep it out of drains and planting beds.',
          'Ice comes back. A path you cleared at 5 a.m. may need another pass at 7. Log your sites and times; it protects the client and us.',
        ] },
        help(V.simaShovel, V.simaPush, V.penguin, V.simaWalk, V.simaDeicer),
      ],
      checks: [
        { q: 'You\'re clearing heavy, wet snow off a long walkway by hand. What\'s the best technique?',
          options: ['Big scoops so you finish faster.', 'Push it to the side where you can; when you must lift, keep loads small and face where it\'s going.', 'Throw it over your shoulder to save steps.'],
          correct: 1, explain: 'Pushing beats lifting. Small loads, legs not back, and no twisting.' },
      ],
    },
    {
      id: 'cold', title: 'Cold, carbon monoxide and emergencies', mins: 6,
      lede: 'Cold stress creeps up slowly, and the person who has it is often the last to notice. Watch your crewmates and have them watch you.',
      blocks: [
        cold,
        { kind: 'text', paragraphs: ['Rotate into a warm truck or building to warm up. Report symptoms early. Don\'t try to tough it out.'] },
        { kind: 'callout', tone: 'danger', label: 'Carbon monoxide:', text: 'fuel and start the blower outdoors only, never in a garage, shed, trailer or loading bay. Refuel with the engine off and cool.' },
        { kind: 'cards', title: 'If something goes wrong', cards: [
          { title: 'Auger injury', text: 'Machine off, call 911, firm pressure on the bleeding. Wrap any severed part, bag it, keep it cold (not directly on ice), send it with them.' },
          { title: 'Struck by a vehicle', text: 'Call 911. Don\'t move them unless they\'re in more danger. Secure the scene and control traffic.' },
          { title: 'Any serious injury', text: 'Call 911, then your Supervisor, then WorkSafeBC 1-888-621-7233. Leave the scene as it is.' },
        ] },
        help(V.coldStress, V.coSmall),
      ],
      checks: [coldCheck, coCheck],
    },
  ],
};

// ─────────────────────────────────────────────────────────────── SWP-17
export const winterBrine: Course = {
  id: 'winter-swp17-brine',
  title: 'Winter: Liquid Brine Application (SWP-17)',
  summary: 'Mixing, loading and spraying brine from the truck, and driving with a sloshing tank, safely.',
  audience: 'Snow & ice crew and brine truck operators',
  pocketCard: [
    { title: 'Before you roll', ordered: true, items: [
      'Anti-icing or de-icing? Brine goes on bare pavement before the storm',
      'Inspect the tank, pump, spray bar, hoses and lights',
      'Mix per the SDS: chemical gloves and eye protection',
    ] },
    { title: 'Loaded tank', items: [
      'Liquid shifts: brake gently, steer smoothly',
      'Much longer stopping distance on ice',
      'Beacon and headlights on',
    ] },
    { title: 'Never', items: [
      'Work on the nozzles or pump while pressurized',
      'Rinse a spill into a storm drain',
      'Spray people, cars or landscaping',
    ] },
  ],
  modules: [
    {
      id: 'when', title: 'How brine works, and when to use it', mins: 5,
      lede: 'Brine works on bare pavement before snow or frost arrives, so ice can\'t bond to the surface. Sprayed on top of deep snow, it doesn\'t do much.',
      blocks: [
        swpNote('SWP-17'),
        { kind: 'compare', title: 'Anti-icing vs. de-icing', no: { title: 'De-icing (after)', items: ['Ice or snow is already bonded', 'Takes more product', 'Often switch to plowing or granular salt instead'] }, yes: { title: 'Anti-icing (before)', items: ['Clear or dry pavement, ahead of the storm or frost', 'Stops the bond from forming', 'Uses far less salt'] } },
        { kind: 'text', paragraphs: ['Your Supervisor sets the route and timing from the forecast and pavement temperatures. If conditions change, re-apply or switch to plowing or granular salt, and tell the plow crews.'] },
        help(V.mainroad, V.iowaAnti, V.simaLiquid),
      ],
      checks: [
        { q: 'It\'s already snowed 10 cm and the lot is covered. Should you spray brine on it?',
          options: ['Yes, more brine melts more snow.', 'No. Brine works best on bare pavement before the storm. This lot needs plowing first, then the Supervisor decides on treatment.', 'Yes, but double the rate.'],
          correct: 1, explain: 'Anti-icing goes on bare pavement. On accumulated snow, plow first.' },
      ],
    },
    {
      id: 'mix', title: 'Inspect, mix and fill', mins: 5,
      lede: 'Brine is salt water, but it still stings eyes and dries out skin. The pump and hoses are under pressure.',
      blocks: [
        { kind: 'list', title: 'Inspect the system', items: [
          'Tank secure on the truck. Pump, spray bar and nozzles clear.',
          'Hoses and fittings sound, no leaks. Beacon and lights working.',
          'Confirm the spray pattern. Check it the way the operator\'s manual says; a defective unit gets tagged out.',
        ] },
        { kind: 'list', title: 'Mixing and filling', items: [
          'Follow the product SDS and the mix ratio.',
          'Chemical-resistant gloves and safety glasses or goggles while mixing and filling.',
          'Avoid splashing. Watch your footing; the fill area gets slick.',
          'Lift salt bags and hoses properly: legs, not back.',
        ] },
        { kind: 'callout', label: 'Brine in the eyes or on skin:', text: 'flush with clean water for at least 15 minutes, take off contaminated clothing, and get medical attention if irritation continues.' },
        help(V.simaDeicer),
      ],
      checks: [
        { q: 'Brine splashes in your eye while you\'re filling the tank. What do you do?',
          options: ['Blink it out and keep going.', 'Flush with clean water for at least 15 minutes, then get it checked if it still hurts.', 'Rub it with your glove.'],
          correct: 1, explain: 'At least 15 minutes of flushing. This is why goggles go on before you start mixing.' },
      ],
    },
    {
      id: 'drive', title: 'Driving a loaded tank and spraying', mins: 6,
      lede: 'A part-full tank is a moving load. The liquid keeps going when you brake or turn, and on ice that can push the truck.',
      blocks: [
        { kind: 'cards', title: 'Driving a tanker', cards: [
          { title: 'Gentle brakes', text: 'Brake early and smoothly. A liquid surge can shove the truck forward on ice.' },
          { title: 'Smooth steering', text: 'No sudden turns. Slosh can push you wide in a corner.' },
          { title: 'Room', text: 'Leave much more following distance than normal. Stopping distance is longer loaded, and longer again on ice.' },
        ] },
        { kind: 'list', title: 'While applying', items: [
          'Beacon on. Use cones, signs and a spotter when you\'re working near people or backing.',
          'Apply at the set rate and speed. Keep the spray on the pavement and off people, cars and landscaping.',
          'Don\'t over-apply. Watch for runoff on slopes and keep brine out of storm drains and planting beds.',
          'Log sites, times and application rates.',
        ] },
        { kind: 'callout', tone: 'danger', label: 'Spill?', text: 'Contain it and clean it up. Never rinse brine into a storm drain. Report a large spill or one that reaches a drain or waterway to your Supervisor.' },
        help(V.behindPlow),
      ],
      checks: [
        { q: 'You\'re approaching a stop sign with a half-full brine tank on a slick road. How do you stop?',
          options: ['Normally. The tank is strapped down.', 'Start braking early and gently so the liquid doesn\'t surge.', 'Brake hard at the last second to stop the slosh quickly.'],
          correct: 1, explain: 'Early, gentle braking keeps the liquid from surging forward and pushing the truck.' },
      ],
    },
    {
      id: 'pressure', title: 'Pressure, clogs, cold and emergencies', mins: 5,
      lede: 'A pinhole leak in a pressurized line can inject fluid under your skin. It looks like a small cut and it can cost you a hand.',
      blocks: [
        { kind: 'callout', tone: 'danger', label: 'Never work on the spray bar, nozzles or pump while it\'s running or pressurized.', text: 'Shut down and relieve the pressure first, then clear the nozzle or fix the leak. Never feel for a leak with your hand.' },
        { kind: 'text', title: 'Injection injury', paragraphs: ['Shut down the pump and call 911. Even a tiny wound from pressurized fluid needs a hospital right away. It won\'t look serious at first, and that\'s the danger.'] },
        { kind: 'list', title: 'End of run', items: [
          'Flush the system and nozzles per the manual so salt doesn\'t crystallize and clog them.',
          'Refill ready for the next run. Report defects and low product.',
          'Warm up in the cab when you need to, and watch your crewmates for cold stress.',
        ] },
        cold,
        help(V.injectionFA, V.injection, V.coldStress),
      ],
      checks: [
        { q: 'A nozzle is clogged and a fitting is weeping brine. The pump is running. What\'s next?',
          options: ['Wipe the fitting and poke the nozzle clear while it runs so you can see the spray.', 'Shut down, relieve the pressure, then clear the nozzle and fix the fitting.', 'Run your hand along the hose to find the leak.'],
          correct: 1, explain: 'Pressurized fluid can inject under the skin. Shut down and relieve pressure before you touch anything.' },
      ],
    },
  ],
};

// ─────────────────────────────────────────────────────────────── SWP-18
export const winterPlowTrucks: Course = {
  id: 'winter-swp18-plow-trucks',
  title: 'Winter: Snow Plowing with Trucks (SWP-18)',
  summary: 'Hook-up, plowing lots and driveways, backing, stacking and fatigue on long storm nights.',
  audience: 'Truck and plow operators',
  pocketCard: [
    { title: 'Pre-trip', ordered: true, items: [
      'Lights, beacon, backup alarm, brakes, tires/chains',
      'Hydraulics, blade, mounting pins, washer fluid',
      'Blade raises, lowers and angles right',
    ] },
    { title: 'Backing', ordered: true, items: [
      'Only when you have to',
      'Mirrors + camera, then horn',
      'Spotter in view, never behind the truck',
      'Slow',
    ] },
    { title: 'Never', items: [
      'Stand or reach under a raised blade',
      'Block hydrants, fire lanes, exits or drains with snow',
      'Idle in an enclosed space to warm up',
      'Leave the blade up when parked',
    ] },
  ],
  modules: [
    {
      id: 'pretrip', title: 'Pre-trip and hooking up the plow', mins: 6,
      lede: 'Hook-up is where hands get crushed. A raised blade that drops can kill you.',
      blocks: [
        swpNote('SWP-18'),
        { kind: 'list', title: 'Pre-trip the truck and plow', items: [
          'Lights, beacon, backup alarm, brakes, tires or chains, washer fluid.',
          'Hydraulics, blade and mounting pins. The blade must raise, lower and angle correctly.',
          'Check it the way the operator\'s manual says. Tag out anything defective.',
        ] },
        { kind: 'callout', tone: 'danger', label: 'Hook-up rule:', text: 'keep your hands clear of pinch points, and never reach or stand under a raised blade that isn\'t supported. Use blocking or stands, and follow the mounting procedure for that plow.' },
        { kind: 'text', paragraphs: ['Before your first storm, review the route and site maps with your Supervisor: curbs, islands, hydrants, drains, exits, and where snow may and may not be stacked.'] },
        help(V.simaMount, V.simaCab),
      ],
      checks: [
        { q: 'A mounting pin won\'t line up during hook-up. The blade is raised on the hydraulics. What do you do?',
          options: ['Reach under the blade and wiggle the pin in.', 'Lower the blade or support it with blocking or stands first, keep your hands out of the pinch points, then line it up.', 'Have a crewmate hold the blade while you push the pin.'],
          correct: 1, explain: 'Hydraulics can bleed down or fail. Never put any part of your body under a raised, unsupported blade.' },
      ],
    },
    {
      id: 'plowing', title: 'Plowing to conditions', mins: 6,
      lede: 'In blowing snow at 4 a.m., people are almost invisible. Assume someone is beside or behind you.',
      blocks: [
        { kind: 'list', title: 'Driving and plowing', items: [
          'Slow and smooth, with more following and stopping distance. Beacon and headlights on.',
          'No sudden steering or braking. Don\'t overload the push.',
          'Keep a constant lookout. Slow right down anywhere people could be: entrances, walkways, between parked cars.',
          'Keep the blade low near people and structures. Raise it only to travel, and don\'t travel with it angled high into your blind spot.',
          'Watch the blade corners near parked cars, walls, gas meters and buildings.',
        ] },
        { kind: 'cards', title: 'Where snow can\'t go', cards: [
          { title: 'Life safety', text: 'Hydrants, fire lanes and building exits. Never block them.' },
          { title: 'Sightlines', text: 'Lot entrances and corners. Piles that hide traffic cause crashes.' },
          { title: 'Drains & accessible parking', text: 'Keep them clear. Don\'t push snow onto a live road.' },
        ] },
        help(V.plow101),
      ],
      checks: [
        { q: 'The quickest place to stack this pile is in front of a fire hydrant at the edge of the lot. What do you do?',
          options: ['Stack it there and clear the hydrant later.', 'Stack it only in an approved area, and keep hydrants, exits, drains and sightlines clear.', 'Stack it there if the pile is small.'],
          correct: 1, explain: 'A buried hydrant can cost a building in a fire. Approved stacking areas only.' },
      ],
    },
    {
      id: 'backing', title: 'Backing and spotters', mins: 5,
      lede: 'Most plow-truck incidents with people happen in reverse.',
      blocks: [
        { kind: 'ladder', rungs: [
          { level: '1', who: 'Do you have to back up?', role: 'Plan to go forward', text: 'Plan your pushes so you back up as little as possible.' },
          { level: '2', who: 'Look', role: 'Mirrors and camera', text: 'Check both mirrors and the camera. The backup alarm must be working.' },
          { level: '3', who: 'Warn', role: 'Horn', text: 'Sound the horn before you move.' },
          { level: '4', who: 'Spotter if people are around', role: 'In view, never behind', text: 'The spotter stays where you can see them and never stands in the truck\'s path. Agree on hand signals first. Lose sight of them? Stop.' },
          { level: '5', who: 'Back slowly', role: 'Walking pace', text: 'Assume a person is in your blind spot.' },
        ] },
        help(V.simaBack, V.signals),
      ],
      checks: [
        { q: 'Your spotter walks out of your mirror view while you\'re backing. What do you do?',
          options: ['Keep backing slowly. They\'re probably fine.', 'Stop until you can see them again.', 'Honk and keep going.'],
          correct: 1, explain: 'If you can\'t see your spotter, you don\'t know where they are. Stop.' },
      ],
    },
    {
      id: 'fatigue', title: 'Fatigue, parking up and emergencies', mins: 5,
      lede: 'Storm nights are long. A tired operator misjudges distance, and that\'s how blade corners hit cars and people.',
      blocks: [
        { kind: 'list', title: 'Fatigue', items: [
          'Take breaks and rotate on long storm events.',
          'Tell your Supervisor when you\'re too tired to keep going safely. That\'s the right call, not a weakness.',
          'Never run the engine in an enclosed space to keep warm.',
        ] },
        { kind: 'list', title: 'Parking up', items: [
          'Blade lowered to the ground and supported. Never leave it raised.',
          'Park on level ground and chock the wheels where you can. Refuel ready for the next run.',
          'Report property damage, new hazards and defects honestly. Log sites, times and conditions.',
        ] },
        { kind: 'cards', title: 'If something goes wrong', cards: [
          { title: 'Collision or pedestrian struck', text: 'Call 911. Don\'t move them unless they\'re in more danger. Secure the scene and call your Supervisor.' },
          { title: 'Blade crush or pinch', text: 'Call 911, firm pressure on the bleeding. Don\'t lift the equipment off a person without proper means.' },
          { title: 'Stuck or sliding off', text: 'Stop safely, beacon on and call for help. Don\'t attempt an unsafe recovery.' },
        ] },
        help(V.fatigue),
      ],
      checks: [
        { q: 'It\'s hour 11 of a storm. You just clipped a curb you\'ve plowed around all season and your eyes keep closing. What now?',
          options: ['Grab an energy drink and finish your route.', 'Pull over somewhere safe and tell your Supervisor you need rest or relief.', 'Turn the radio up and open the window.'],
          correct: 1, explain: 'Clipping a known curb is a fatigue warning. Stop and report it. A rested operator finishes the route later.' },
        coCheck,
      ],
    },
  ],
};

// ─────────────────────────────────────────────────────────────── SWP-19
export const winterSkidSteer: Course = {
  id: 'winter-swp19-skid-steer',
  title: 'Winter: Skid-Steer / Bobcat Snow Clearing (SWP-19)',
  summary: 'Blind spots, rollovers, lift-arm crush points and attachment changes when clearing and stacking snow.',
  audience: 'Skid-steer / Bobcat operators and spotters',
  pocketCard: [
    { title: 'Getting on', ordered: true, items: [
      'Clear the steps and handholds of snow and ice',
      'Three points of contact',
      'Seatbelt on, restraint bar down',
      'Never mount or reach under raised arms',
    ] },
    { title: 'Operating', items: [
      'Bucket low, slow on ice',
      'Straight up and down slopes, never across',
      'People out of the work zone',
      'Mirrors + camera + horn before backing',
    ] },
    { title: 'Getting off', ordered: true, items: [
      'Attachment on the ground',
      'Park brake on',
      'Engine off, key out as required',
    ] },
  ],
  modules: [
    {
      id: 'pretrip', title: 'Pre-trip, getting on, and the cab', mins: 5,
      lede: 'Only trained, authorized operators run the machine. The cab, the seatbelt and the restraint bar are what save you in a rollover.',
      blocks: [
        swpNote('SWP-19'),
        { kind: 'list', title: 'Pre-trip', items: [
          'Tires or tracks, lights, beacon, backup alarm, hydraulics and mirrors.',
          'Clean glass. Frosted or iced windows are a blind spot. Scrape them clear.',
          'Attachment pins fully locked. Check it the way the operator\'s manual says, and tag out defects.',
          'ROPS/FOPS cab in place.',
        ] },
        { kind: 'callout', tone: 'danger', label: 'Getting on and off:', text: 'clear snow and ice off the steps and handholds, use three points of contact, and never climb in or out, or reach, under raised lift arms.' },
        help(V.bobcatSafe),
      ],
      checks: [
        { q: 'The cab glass is frosted over and the steps are icy. You\'re running late. What do you do?',
          options: ['Hop in and defrost the glass as you work.', 'Clear the steps and glass first, climb in with three points of contact, belt on and restraint bar down.', 'Leave the door open so you can see out.'],
          correct: 1, explain: 'Iced glass is a blind spot and icy steps are a fall. Two minutes of clearing is part of the job.' },
      ],
    },
    {
      id: 'zone', title: 'Blind spots and the work zone', mins: 5,
      lede: 'From the seat of a skid-steer you can\'t see a lot of the ground around the machine, especially behind you and right beside the bucket.',
      blocks: [
        { kind: 'list', title: 'Keep people out', items: [
          'Plan push and stack directions and set an exclusion zone with cones before you start.',
          'Never operate with someone in your travel or swing path.',
          'If others must be nearby, use a spotter in hi-vis who stays in view and clear of your path. Agree on hand signals first.',
          'Before backing: mirrors, camera, horn, then slowly. The backup alarm must work.',
        ] },
        { kind: 'callout', label: 'Assume', text: 'every blind spot is hiding a person.' },
        help(V.blindSpots, V.signals),
      ],
      checks: [
        { q: 'A crewmate with a shovel starts working along the curb right where you\'re pushing snow. What do you do?',
          options: ['Keep working. They can see the machine.', 'Stop the machine and sort out a plan: they move out of the zone or a spotter is set up first.', 'Honk and keep pushing.'],
          correct: 1, explain: 'Never run the machine with a person in the travel path. Stop, then reset the zone.' },
      ],
    },
    {
      id: 'stability', title: 'Slopes, ice and stacking', mins: 5,
      lede: 'A skid-steer tips more easily than it looks, especially with a raised load on a slope or a snow pile.',
      blocks: [
        { kind: 'compare', title: 'Staying upright', no: { title: 'Tips machines', items: ['Travelling with the bucket raised', 'Driving across a slope', 'Sharp turns while loaded', 'Climbing a snow pile'] }, yes: { title: 'Do this', items: ['Bucket and load low', 'Straight up and down slopes', 'Slow on ice', 'Stack from the base and keep piles stable'] } },
        { kind: 'list', title: 'Stacking', items: [
          'Approved areas only. Keep clear of drains, hydrants and exits.',
          'Watch pile height and stability. Don\'t undercut a pile or climb it.',
          'Look up and down for overhead lines and buried hazards.',
        ] },
        { kind: 'callout', tone: 'danger', label: 'If it rolls:', text: 'stay belted inside the cab and brace. Do not try to jump clear; the cab protects you and the machine crushes people who jump. Once it stops, check for injuries and call 911 if anyone is hurt.' },
        help(V.bobcatBlade),
      ],
      checks: [
        { q: 'The machine starts to tip sideways on an icy slope. What do you do?',
          options: ['Jump out the door before it goes over.', 'Stay belted in, hold on and brace inside the cab.', 'Unbuckle so you can get out faster afterward.'],
          correct: 1, explain: 'Operators who try to jump are crushed by the machine. The ROPS cab and seatbelt are designed to protect you.' },
      ],
    },
    {
      id: 'attach', title: 'Attachments, shutting down and emergencies', mins: 5,
      lede: 'Attachment changes and climbing out with the arms up are where operators get pinned.',
      blocks: [
        { kind: 'list', title: 'Changing attachments', items: [
          'Level ground, arms down, engine off, unless the coupler\'s manual says otherwise.',
          'Keep clear of pinch points.',
          'Confirm the pins are fully engaged before you use the attachment.',
        ] },
        { kind: 'list', title: 'Before you leave the seat', items: [
          'Never leave the seat with the engine running or the arms raised.',
          'Lower the attachment to the ground, set the park brake, shut down and remove the key as required.',
          'Take warm-up breaks, but never idle the machine in an enclosed space.',
          'Report damage, new hazards and defects. Log the work done.',
        ] },
        { kind: 'cards', title: 'If something goes wrong', cards: [
          { title: 'Run-over or crush', text: 'Call 911. Don\'t move them unless they\'re in more danger. Don\'t lift the machine off a person without proper means.' },
          { title: 'Any serious injury', text: 'Call 911, then your Supervisor, then WorkSafeBC 1-888-621-7233. Leave the scene as it is.' },
        ] },
        help(V.bobcatSafe),
      ],
      checks: [
        { q: 'You need to hop out to move a pylon. The bucket is half raised. What do you do first?',
          options: ['Leave it running so you can get going again fast.', 'Lower the bucket to the ground, set the park brake and shut down before you climb out.', 'Raise the arms higher so you can walk under them.'],
          correct: 1, explain: 'Bucket down, brake on, engine off, every time you leave the seat.' },
      ],
    },
  ],
};

// ─────────────────────────────────────────────────────────────── SWP-20
export const winterDriving: Course = {
  id: 'winter-swp20-driving',
  title: 'Winter: Driving & Storm Call-Out (SWP-20)',
  summary: 'Getting to and between sites in a storm: winter-ready vehicles, driving to conditions, whiteouts, fatigue and getting stranded.',
  audience: 'All drivers and snow & ice crews',
  pocketCard: [
    { title: 'Before you drive', ordered: true, items: [
      'Fit to drive? Rested, not impaired',
      'Clear ALL snow: glass, lights, roof',
      'Tires/chains, brakes, wipers, washer fluid, fuel',
      'Load tied down, emergency kit aboard',
    ] },
    { title: 'On the road', items: [
      'Slow down, way more following distance',
      'Bridges, ramps and shade = black ice',
      'No hand-held phone; pull over for dispatch',
      'Fuel above half',
    ] },
    { title: 'Stuck or whiteout', items: [
      'Pull fully off the road, hazards + beacon on',
      'Never stop in a live lane',
      'Stay with the vehicle; call for help',
      'Running for heat? Clear the exhaust, crack a window',
    ] },
  ],
  modules: [
    {
      id: 'ready', title: 'Fit to drive, and a winter-ready vehicle', mins: 5,
      lede: 'The call-out starts with two questions: are you fit to drive, and is the vehicle?',
      blocks: [
        swpNote('SWP-20'),
        { kind: 'callout', label: 'Fit to drive:', text: 'rested, and not impaired by fatigue, medication or alcohol. If you\'re too tired, tell your Supervisor and don\'t start or continue.' },
        { kind: 'list', title: 'Winter pre-trip', items: [
          'Winter tires and/or chains as required. Brakes, lights, wipers, winter washer fluid, heater and defrost. Fuel topped up.',
          'Clear ALL the snow and ice: every window, the lights and the roof. Roof snow slides onto your windshield, or onto the driver behind you.',
          'Tie down salt bags and tools. In a sudden stop they become projectiles.',
          'Emergency kit aboard: blanket, food and water, flashlight, first-aid kit, traction aids, shovel, booster cables, phone charger.',
        ] },
        help(V.clearCar),
      ],
      checks: [
        { q: 'It\'s 3 a.m. and the truck has 15 cm of snow on the roof. You\'ve cleared the windshield. Good to go?',
          options: ['Yes, the windshield is what matters.', 'No. Clear every window, the lights and the roof first.', 'Yes, it\'ll blow off on the highway.'],
          correct: 1, explain: 'Roof snow can slide onto your windshield when you brake, or fly off into the driver behind you.' },
      ],
    },
    {
      id: 'conditions', title: 'Driving to conditions', mins: 6,
      lede: 'Posted speed limits are for ideal conditions. A storm night isn\'t one.',
      blocks: [
        { kind: 'cards', title: 'The basics', cards: [
          { title: 'Slow down', text: 'Reduce speed and leave much more following distance than the dry-road rule.' },
          { title: 'Smooth', text: 'Steering, braking and accelerating all gentle. Sudden inputs cause skids.' },
          { title: 'Black ice', text: 'Bridges, ramps, overpasses and shaded spots freeze first. Slow down before you reach them.' },
        ] },
        { kind: 'list', title: 'Also', items: [
          'Lights on and glass clear.',
          'No hand-held phone. Pull over safely for dispatch and calls, or use hands-free per the law and our policy.',
          'Give room to pedestrians, other plows, stopped vehicles and emergency vehicles. Everyone has less traction.',
          'Keep fuel above half and tell your Supervisor or dispatch where you are and where you\'re heading.',
        ] },
        help(V.cbcWinter, V.crWinter, V.blackIce),
      ],
      checks: [
        { q: 'The road is wet and just above freezing, and you\'re coming up on a bridge. What do you do?',
          options: ['Keep your speed. The road is just wet.', 'Ease off before the bridge and drive across smoothly, with no braking or sharp steering on it.', 'Speed up to get across quickly.'],
          correct: 1, explain: 'Bridges freeze before the road around them. Slow down before you reach them, not on them.' },
        { q: 'Dispatch texts you a new site address while you\'re driving. What do you do?',
          options: ['Read it at the next red light.', 'Pull over somewhere safe, then read and reply.', 'Glance at it quickly; it\'s only an address.'],
          correct: 1, explain: 'Handle dispatch when you\'re stopped. Eyes on the road.' },
      ],
    },
    {
      id: 'stranded', title: 'Whiteouts, getting stuck and fatigue', mins: 6,
      lede: 'If you can\'t see, or you\'re stuck, the most dangerous place to be is a live traffic lane.',
      blocks: [
        { kind: 'callout', tone: 'danger', label: 'Whiteout:', text: 'slow down, and if you need to, pull fully off the road with hazards and beacon on and wait it out. Never stop in a live lane.' },
        { kind: 'list', title: 'Stuck or broken down', items: [
          'Get as far off the road as you can. Hazards and beacon on. Call for help.',
          'Stay with the vehicle. Stay buckled inside if traffic is a danger.',
          'If you run the engine for heat, keep the exhaust pipe clear of snow and crack a window. A buried exhaust fills the cab with carbon monoxide.',
        ] },
        { kind: 'text', title: 'Drowsy driving', paragraphs: ['Heavy eyes, drifting in your lane and missed turns are warning signs. Pull over somewhere safe, rest or swap drivers, and tell your Supervisor. Fighting through it doesn\'t work.'] },
        help(V.stranded, V.fatigue),
      ],
      checks: [
        { q: 'You\'re stuck in a snowbank on the shoulder with the engine running for heat. Snow keeps drifting around the back of the truck. What\'s the hidden danger?',
          options: ['Running out of fuel.', 'Carbon monoxide from a snow-blocked exhaust. Keep the exhaust clear and crack a window.', 'The battery dying.'],
          correct: 1, explain: 'A blocked exhaust pushes CO into the cab. You won\'t smell it.' },
        { q: 'Halfway to a site, you catch yourself drifting toward the shoulder for the second time. What do you do?',
          options: ['Open the window and push on. You\'re nearly there.', 'Pull over somewhere safe, rest or swap drivers, and tell your Supervisor.', 'Drive faster to get there sooner.'],
          correct: 1, explain: 'Drifting is a drowsy-driving warning. Stop, rest, and report it.' },
      ],
    },
  ],
};

export const WINTER_COURSES: Course[] = [winterDriving, winterSidewalks, winterPlowTrucks, winterSkidSteer, winterBrine];
