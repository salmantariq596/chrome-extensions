# bz_k_v2_scraper

Chrome extension to scrape contractor data from BuildZoom search results.

## Installation
1. Open Chrome → `chrome://extensions/`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select the `bz_k_v2_scraper` folder

## Usage
1. Go to https://www.buildzoom.com/search?keywords=roofers
2. Click the BZ extension icon
3. Click **Scrape Page**
4. Download CSV or JSON

## Features
- Auto-deduplicates contractor links (strips #fragments)
- Auto-detects card containers by walking up from `/contractor/` links
- Extracts: name, ID, URL, BZ score, price range, address, phone, rating, reviews, description, projects, license, years in business
- Highlights cards for visual verification
