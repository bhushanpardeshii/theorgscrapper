const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const BASE_URL = 'https://theorg.com/companies';
const OUTPUT_CSV = path.join(__dirname, 'output.csv');
const PROGRESS_FILE = path.join(__dirname, 'scraping_progress.json');
const QUEUE_FILE = path.join(__dirname, 'company_queue.json');
const CONCURRENCY_LIMIT = 5;

// Load progress if exists
let progress = {
    processedCompanies: new Set(),
    lastTabUrl: null,
    lastPageUrl: null,
    totalProcessed: 0
};

// Load or initialize company queue
let companyQueue = [];

if (fs.existsSync(PROGRESS_FILE)) {
    const savedProgress = JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8'));
    progress.processedCompanies = new Set(savedProgress.processedCompanies);
    progress.lastTabUrl = savedProgress.lastTabUrl;
    progress.lastPageUrl = savedProgress.lastPageUrl;
    progress.totalProcessed = savedProgress.totalProcessed || 0;
}

if (fs.existsSync(QUEUE_FILE)) {
    companyQueue = JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8'));
}

// Save progress
function saveProgress() {
    fs.writeFileSync(PROGRESS_FILE, JSON.stringify({
        processedCompanies: Array.from(progress.processedCompanies),
        lastTabUrl: progress.lastTabUrl,
        lastPageUrl: progress.lastPageUrl,
        totalProcessed: progress.totalProcessed
    }));
}

// Save queue
function saveQueue() {
    fs.writeFileSync(QUEUE_FILE, JSON.stringify(companyQueue));
}

// Add companies to queue
function addToQueue(companies, sourceurl) {
    const newCompanies = companies.filter(company => !progress.processedCompanies.has(company.name));
    companyQueue.push(...newCompanies.map(company => ({
        ...company,
        sourceurl
    })));
    saveQueue();
}

// Process a single company
async function processCompany(browser, company) {
    if (progress.processedCompanies.has(company.name)) {
        return;
    }

    let retryCount = 0;
    const maxRetries = 3;

    while (retryCount < maxRetries) {
        try {
            const companyPage = await browser.newPage();
            await companyPage.goto(company.url, { waitUntil: 'networkidle2' });

            let homepageUrl = '';
            if (await waitForSelectorSafe(companyPage, 'a.sc-6de434d-3.fxxeMP[title="View the website"]')) {
                homepageUrl = await companyPage.$eval('a.sc-6de434d-3.fxxeMP[title="View the website"]', a => a.href);
            }

            // Write to CSV
            fs.appendFileSync(
                OUTPUT_CSV,
                `"${company.sourceurl}","${company.name}","${homepageUrl}"\n`
            );

            progress.processedCompanies.add(company.name);
            progress.totalProcessed++;
            saveProgress();
            await companyPage.close();
            return true;
        } catch (err) {
            console.error(`Error scraping company ${company.name} (attempt ${retryCount + 1}/${maxRetries}):`, err.message);
            retryCount++;
            if (retryCount < maxRetries) {
                await new Promise(resolve => setTimeout(resolve, 30000)); // Wait 30 seconds before retry
            }
        }
    }
    return false;
}

// Process companies in chunks
async function processCompaniesInChunks(browser) {
    while (companyQueue.length > 0) {
        const chunk = companyQueue.splice(0, CONCURRENCY_LIMIT);
        const results = await Promise.all(chunk.map(company => processCompany(browser, company)));

        // Add failed companies back to the front of the queue
        const failedCompanies = chunk.filter((_, index) => !results[index]);
        companyQueue.unshift(...failedCompanies);
        saveQueue();

        // If all companies in chunk failed, wait before retrying
        if (failedCompanies.length === chunk.length) {
            await new Promise(resolve => setTimeout(resolve, 30000));
        }
    }
}

// Helper to wait and retry for selectors
async function waitForSelectorSafe(page, selector, timeout = 10000) {
    try {
        await page.waitForSelector(selector, { timeout });
        return true;
    } catch {
        return false;
    }
}

(async () => {
    const browser = await puppeteer.launch({ headless: true });
    const page = await browser.newPage();

    try {
        // Prepare CSV if it doesn't exist
        if (!fs.existsSync(OUTPUT_CSV)) {
            fs.writeFileSync(OUTPUT_CSV, 'sourceurl,company_name,company_homepage_url\n');
        }

        // If we have a queue, process it first
        if (companyQueue.length > 0) {
            console.log(`Resuming with ${companyQueue.length} companies in queue...`);
            await processCompaniesInChunks(browser);
        }

        // Go to base URL
        await page.goto(BASE_URL, { waitUntil: 'networkidle2' });

        // Get all tab links (0-9, A-Z)
        const tabLinks = await page.$$eval('li.sc-2d41e6a8-5.kiuOtN > a', as =>
            as.map(a => ({
                url: a.href,
                text: a.textContent.trim()
            }))
        );

        // Find the starting point based on saved progress
        let startTabIndex = 0;
        if (progress.lastTabUrl) {
            startTabIndex = tabLinks.findIndex(tab => tab.url === progress.lastTabUrl);
            if (startTabIndex === -1) startTabIndex = 0;
        }

        for (let i = startTabIndex; i < tabLinks.length; i++) {
            const tab = tabLinks[i];
            let nextPageUrl = progress.lastPageUrl || tab.url;
            let sourceurl = tab.url;

            progress.lastPageUrl = null;
            saveProgress();

            while (nextPageUrl) {
                try {
                    await page.goto(nextPageUrl, { waitUntil: 'networkidle2' });

                    // Get all company links on this page
                    const companies = await page.$$eval('li.sc-2d41e6a8-7.EuiIB > a', as =>
                        as.map(a => ({
                            name: a.textContent.trim(),
                            url: a.href
                        }))
                    );

                    // Add companies to queue
                    addToQueue(companies, sourceurl);

                    // Process companies in parallel with concurrency limit
                    await processCompaniesInChunks(browser);

                    progress.lastPageUrl = nextPageUrl;
                    progress.lastTabUrl = tab.url;
                    saveProgress();

                    // Extract current page number from URL
                    const currentPageMatch = nextPageUrl.match(/-(\d+)$/);
                    const currentPage = currentPageMatch ? parseInt(currentPageMatch[1]) : 1;

                    // Construct next page URL
                    const nextPage = nextPageUrl.replace(/-(\d+)$/, `-${currentPage + 1}`);

                    // Check if next page exists by making a request
                    try {
                        const response = await page.goto(nextPage, { waitUntil: 'networkidle2' });
                        if (response.status() === 404) {
                            break; // No more pages
                        }
                        nextPageUrl = nextPage; // Update the loop variable
                    } catch (err) {
                        console.error(`Error checking next page ${nextPage}:`, err.message);
                        break; // Stop if we can't access the next page
                    }
                } catch (err) {
                    console.error(`Error on page ${nextPageUrl}:`, err.message);
                    await new Promise(resolve => setTimeout(resolve, 30000));
                    continue;
                }
            }
        }

        // Clean up files after successful completion
        if (fs.existsSync(PROGRESS_FILE)) {
            fs.unlinkSync(PROGRESS_FILE);
        }
        if (fs.existsSync(QUEUE_FILE)) {
            fs.unlinkSync(QUEUE_FILE);
        }
        console.log(`Scraping complete! Processed ${progress.totalProcessed} companies. Data saved to output.csv`);
    } catch (err) {
        console.error('Fatal error:', err.message);
        console.log('Progress has been saved. You can resume the scraping later.');
    } finally {
        await browser.close();
    }
})();
