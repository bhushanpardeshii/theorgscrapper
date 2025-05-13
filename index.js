const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const BASE_URL = 'https://theorg.com/companies';
const OUTPUT_CSV = path.join(__dirname, 'output.csv');
const CONCURRENCY_LIMIT = 5; // Number of concurrent browser pages
const processedCompanies = new Set(); // Track processed companies

// Helper to wait and retry for selectors
async function waitForSelectorSafe(page, selector, timeout = 10000) {
    try {
        await page.waitForSelector(selector, { timeout });
        return true;
    } catch {
        return false;
    }
}

// Process a single company
async function processCompany(browser, company, sourceurl) {
    if (processedCompanies.has(company.name)) {
        return; // Skip if already processed
    }

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
            `"${sourceurl}","${company.name}","${homepageUrl}"\n`
        );

        processedCompanies.add(company.name);
        await companyPage.close();
    } catch (err) {
        console.error(`Error scraping company ${company.name}:`, err.message);
    }
}

// Process companies in chunks
async function processCompaniesInChunks(browser, companies, sourceurl) {
    for (let i = 0; i < companies.length; i += CONCURRENCY_LIMIT) {
        const chunk = companies.slice(i, i + CONCURRENCY_LIMIT);
        await Promise.all(chunk.map(company => processCompany(browser, company, sourceurl)));
    }
}

(async () => {
    const browser = await puppeteer.launch({ headless: true });
    const page = await browser.newPage();

    // Go to base URL
    await page.goto(BASE_URL, { waitUntil: 'networkidle2' });

    // Get all tab links (0-9, A-Z)
    const tabLinks = await page.$$eval('li.sc-2d41e6a8-5.kiuOtN > a', as =>
        as.map(a => ({
            url: a.href,
            text: a.textContent.trim()
        }))
    );

    // Prepare CSV
    fs.writeFileSync(OUTPUT_CSV, 'sourceurl,company_name,company_homepage_url\n');

    for (const tab of tabLinks) {
        let nextPageUrl = tab.url;
        let sourceurl = tab.url;

        while (nextPageUrl) {
            await page.goto(nextPageUrl, { waitUntil: 'networkidle2' });

            // Get all company links on this page
            const companies = await page.$$eval('li.sc-2d41e6a8-7.EuiIB > a', as =>
                as.map(a => ({
                    name: a.textContent.trim(),
                    url: a.href
                }))
            );

            // Process companies in parallel with concurrency limit
            await processCompaniesInChunks(browser, companies, sourceurl);

            // Find next page link (pagination)
            const nextPage = await page.$$eval('li.sc-2d41e6a8-5.kiuOtN > a', as => {
                const current = as.find(a => a.getAttribute('aria-disabled') === 'true');
                if (!current) return null;
                const currentIndex = as.indexOf(current);
                if (currentIndex >= 0 && currentIndex < as.length - 1) {
                    return as[currentIndex + 1].href;
                }
                return null;
            });

            if (!nextPage || nextPage === nextPageUrl) break;
            nextPageUrl = nextPage;
        }
    }

    await browser.close();
    console.log('Scraping complete! Data saved to output.csv');
})();
