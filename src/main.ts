import type { ProxyConfigurationOptions } from 'apify';
import { Actor, log } from 'apify';
import { PlaywrightCrawler,sleep } from 'crawlee';

import { testForBlocks } from './check-captchas.js';
import { MAX_ATTACHMENT_SIZE_BYTES } from './consts.js';
import { createSlackMessage,handleFailedAndThrow, screenshotDOMElement, validateInput } from './utils.js';

export interface UrlConfig {
    url: string;
    contentSelector: string;
    screenshotSelector?: string;
    sendNotificationText?: string;
}

export interface Input {
    urls: UrlConfig[];
    sendNotificationTo: string;
    navigationTimeout?: number;
    informOnError: string;
    maxRetries?: number;
    retryStrategy?: 'on-block' | 'on-all-errors' | 'never-retry';
}

await Actor.init();

// Try to get input from Actor.getInput(), fallback to reading INPUT.json file for local development
let input: Input;
try {
    const inputRaw = await Actor.getInput();
    
    // Check if we got a valid input (not a character array)
    if (inputRaw && typeof inputRaw === 'object' && !Object.keys(inputRaw).every(key => /^\d+$/.test(key))) {
        input = inputRaw as Input;
    } else {
        throw new Error('Invalid input from Actor.getInput()');
    }
} catch (error) {
    // Fallback: read from INPUT.json file for local development
    const fs = await import('fs/promises');
    const path = await import('path');
    const inputPath = path.join(process.cwd(), 'INPUT.json');
    try {
        const inputFile = await fs.readFile(inputPath, 'utf-8');
        input = JSON.parse(inputFile) as Input;
    } catch (fileError) {
        throw new Error('Could not read input from Actor.getInput() or INPUT.json file');
    }
}

await validateInput(input);

const {
    urls,
    sendNotificationTo,
    navigationTimeout = 30000,
    informOnError,
    maxRetries = 5,
    retryStrategy = 'on-block', // 'on-block', 'on-all-errors', 'never-retry'
} = input;

// define name for a key-value store based on task ID or actor ID
// (to be able to have more content checkers under one Apify account)
let storeName = 'content-checker-store-';
storeName += !process.env.APIFY_ACTOR_TASK_ID ? process.env.APIFY_ACT_ID : process.env.APIFY_ACTOR_TASK_ID;

// use or create a named key-value store
const store = await Actor.openKeyValueStore(storeName);

// RESIDENTIAL proxy would be useful, but we don't want everyone to bother us with those
const proxyConfiguration = await Actor.createProxyConfiguration({ useApifyProxy: false });

const requestQueue = await Actor.openRequestQueue();

// Add all URLs to the request queue
for (const urlConfig of urls) {
    await requestQueue.addRequest({ 
        url: urlConfig.url,
        userData: {
            urlConfig,
            urlKey: Buffer.from(urlConfig.url).toString('base64').replace(/[^a-zA-Z0-9]/g, '')
        }
    });
}

// Store results for each URL
const urlResults = new Map<string, {
    screenshotBuffer?: Buffer;
    fullPageScreenshot?: Buffer;
    content?: string;
    urlConfig: UrlConfig;
}>();

const crawler = new PlaywrightCrawler({
    requestQueue,
    proxyConfiguration,
    maxRequestRetries: retryStrategy === 'never-retry' ? 0 : maxRetries,
    launchContext: {
        launchOptions: {
            viewport: { width: 1920, height: 1080 },
        },
    },
    preNavigationHooks: [async (_crawlingContext, gotoOptions) => {
        gotoOptions!.waitUntil = 'networkidle';
        gotoOptions!.timeout = navigationTimeout;
    }],
    requestHandler: async ({ page, response, injectJQuery, request }) => {
        const { urlConfig, urlKey } = request.userData as { urlConfig: UrlConfig; urlKey: string };
        const { url, contentSelector, screenshotSelector = contentSelector } = urlConfig;
        
        if (response!.status() === 404 && response!.status()) {
            log.warning(`404 Status - Page not found! Please change the URL: ${url}`);
            return;
        }
        if (response!.status() >= 400) {
            throw new Error(`Response status: ${response!.status()}. Probably got blocked, trying again!`);
        }
        log.info(`Page loaded with title: ${await page.title()} on URL: ${url}`);
        // wait 5 seconds (if there is some dynamic content)
        // TODO: this should wait for the selector to be available
        log.info('Sleeping 5s ...');
        await sleep(5_000);

        try {
            await injectJQuery();
        } catch (e) {
            // TODO: Rewrite selectors to non-JQuery
            log.warning('Could not inject JQuery so cannot test captcha presence');
        }

        try {
            await testForBlocks(page);
        } catch (e) {
            const fullPageScreenshot = await page.screenshot({ fullPage: true, type: 'jpeg', quality: 30 }) as Buffer;
            urlResults.set(urlKey, { fullPageScreenshot, urlConfig });
            throw e;
        }

        log.info('Saving screenshot...');

        let errorHappened = false;
        let errorMessage;
        let content: string | undefined;
        let screenshotBuffer: Buffer | undefined;

        try {
            content = await page.$eval(contentSelector, (el) => el.textContent) as string;
        } catch (e) {
            errorHappened = true;
            errorMessage = `Failed to extract the content, either the content `
                + `selector is wrong or page layout changed. Check the full screenshot.`;
        }

        if (!errorHappened) {
            try {
                screenshotBuffer = await screenshotDOMElement(page, screenshotSelector, 10) as Buffer;
            } catch (e) {
                errorHappened = true;
                errorMessage = `Failed to capture the screenshot, either the screenshot or `
                    + `content selector is wrong or page layout changed. Check the full screenshot.`;
            }
        }

        if (errorHappened) {
            const fullPageScreenshot = await page.screenshot({ fullPage: true, type: 'jpeg', quality: 30 }) as Buffer;
            urlResults.set(urlKey, { fullPageScreenshot, urlConfig });
            if (retryStrategy === 'on-all-errors') {
                const updatedMessage = `${errorMessage} Will retry...`;
                throw updatedMessage;
            } else {
                log.warning(errorMessage as string);
            }
        } else {
            // Store successful results
            urlResults.set(urlKey, { screenshotBuffer, content, urlConfig });
        }
    },
});

await crawler.run();

// Process results for each URL
for (const [urlKey, result] of urlResults) {
    const { urlConfig, screenshotBuffer, fullPageScreenshot, content } = result;
    const { url, sendNotificationText } = urlConfig;
    
    // All retries to get screenshot failed
    if (!screenshotBuffer) {
        await handleFailedAndThrow({
            type: 'screenshot',
            fullPageScreenshot,
            informOnError,
            sendNotificationTo,
            url,
        });
        continue;
    }

    if (!content) {
        await handleFailedAndThrow({
            type: 'screenshot',
            fullPageScreenshot,
            informOnError,
            sendNotificationTo,
            url,
        });
        continue;
    }

    // Store current data for this URL
    const currentScreenshotKey = `currentScreenshot_${urlKey}.png`;
    const currentDataKey = `currentData_${urlKey}`;
    
    await store.setValue(currentScreenshotKey, screenshotBuffer, { contentType: 'image/png' });
    await store.setValue(currentDataKey, content);

    // Get previous data for this URL
    const previousScreenshot = await store.getValue(`previousScreenshot_${urlKey}.png`) as Buffer | undefined;
    const previousData = await store.getValue(`previousData_${urlKey}`) as string | undefined;

    log.info(`Processing URL: ${url}`);
    log.info(`Previous data: ${previousData}`);
    log.info(`Current data: ${content}`);

    if (previousScreenshot === null) {
        log.warning(`Running for the first time for URL: ${url}, no check`);
        
        // Push initial data for first run
        await Actor.pushData({
            url,
            previousData: null,
            content,
            previousScreenshotUrl: null,
            currentScreenshotUrl: store.getPublicUrl(currentScreenshotKey),
            sendNotificationTo,
            isFirstRun: true
        });
    } else {
        // store data from this run
        await store.setValue(`previousScreenshot_${urlKey}.png`, previousScreenshot, { contentType: 'image/png' });
        await store.setValue(`previousData_${urlKey}`, previousData);

        // check data
        if (previousData === content) {
            log.warning(`No change for URL: ${url}`);
        } else {
            log.warning(`Content changed for URL: ${url}`);

            const notificationNote = sendNotificationText ? `Note: ${sendNotificationText}\n\n` : '';

            // create Slack message used by Apify slack integration
            const message = createSlackMessage({ 
                url, 
                previousData: previousData!, 
                content: content!, 
                kvStoreId: store.id 
            });
            await Actor.setValue(`SLACK_MESSAGE_${urlKey}`, message);

            await Actor.pushData({
                url,
                previousData,
                content,
                previousScreenshotUrl: store.getPublicUrl(`previousScreenshot_${urlKey}.png`),
                currentScreenshotUrl: store.getPublicUrl(currentScreenshotKey),
                sendNotificationTo,
            });

            if (sendNotificationTo) {
                log.info(`Sending mail to ${sendNotificationTo} for URL: ${url}...`);

                const previousScreenshotBase64 = previousScreenshot!.toString('base64');
                const currentScreenshotBase64 = screenshotBuffer!.toString('base64');

                let text = `URL: ${url}\n\n${notificationNote}Previous data: ${previousData}\n\nCurrent data: ${content}`;
                const attachments = [];
                if (previousScreenshotBase64.length + currentScreenshotBase64.length < MAX_ATTACHMENT_SIZE_BYTES) {
                    attachments.push({
                        filename: `previousScreenshot_${urlKey}.png`,
                        data: previousScreenshotBase64,
                    });
                    attachments.push({
                        filename: `currentScreenshot_${urlKey}.png`,
                        data: currentScreenshotBase64,
                    });
                } else {
                    log.warning(`Screenshots are bigger than ${MAX_ATTACHMENT_SIZE_BYTES}, not sending them as part of email attachment for URL: ${url}.`);
                    text += `\n\nScreenshots are bigger than ${MAX_ATTACHMENT_SIZE_BYTES}, not sending them as part of email attachment.`;
                }

                await Actor.call('apify/send-mail', {
                    to: sendNotificationTo,
                    subject: `Apify content checker - page changed! (${url})`,
                    text,
                    attachments,
                });
            } else {
                log.warning(`No e-mail address provided, email notification skipped for URL: ${url}`);
            }
        }
    }
}

log.info('Done processing all URLs.');
log.info('You can check the output in the named key-value store on the following URLs:');
for (const [urlKey, result] of urlResults) {
    const { urlConfig } = result;
    const { url } = urlConfig;
    log.info(`URL: ${url}`);
    log.info(`- https://api.apify.com/v2/key-value-stores/${store.id}/records/currentScreenshot_${urlKey}.png`);
    log.info(`- https://api.apify.com/v2/key-value-stores/${store.id}/records/currentData_${urlKey}`);
    
    const previousScreenshot = await store.getValue(`previousScreenshot_${urlKey}.png`);
    if (previousScreenshot !== null) {
        log.info(`- https://api.apify.com/v2/key-value-stores/${store.id}/records/previousScreenshot_${urlKey}.png`);
        log.info(`- https://api.apify.com/v2/key-value-stores/${store.id}/records/previousData_${urlKey}`);
    }
}

await Actor.exit();
