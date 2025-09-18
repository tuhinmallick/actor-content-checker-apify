import { Actor } from 'apify';

console.log('Environment variables:');
console.log('APIFY_INPUT_FILE:', process.env.APIFY_INPUT_FILE);
console.log('APIFY_TOKEN:', process.env.APIFY_TOKEN);
console.log('APIFY_ACTOR_TASK_ID:', process.env.APIFY_ACTOR_TASK_ID);

try {
    await Actor.init();
    const input = await Actor.getInput();
    console.log('Input received:', JSON.stringify(input, null, 2));
} catch (error) {
    console.error('Error getting input:', error.message);
}