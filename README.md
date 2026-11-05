# VoucherFlow — version 1

Charity voucher processing: batches per collector, voucher image upload with automatic
barcode reading, validation screen, companies, collectors, users and collector reports.

## What's in version 1
- Logins with three roles: **Admin**, **Batch entry**, **Reconciler**
- **Batches**: every batch requires a collector reference, stamped on every voucher permanently
- **Upload** voucher images (JPG/PNG); barcodes are read automatically
- **Company barcode rules**: recognise the company, and fill amount / account / expiry for rich barcodes
- **Validation screen**: image on the left, fields on the right, Enter saves and moves on
- **Rules**: expired at drop-off or company no longer accepted → *Not valid*, excluded from the collector's count
- **Duplicate** voucher numbers are flagged
- **History** of every change to every voucher; nothing is ever deleted
- **Collector report** with CSV export

Coming next: Outbox and sending, company report emails, remittances, bank CSV import,
reconciliation, collector PDF emails, scanner connection.

## Setup

### 1. Database (Supabase)
1. Supabase → your project → **SQL Editor** → **New query**.
2. Paste the whole of `supabase/schema.sql` and click **Run**.
3. **Authentication → Users → Add user → Create new user**: your own email and a password,
   tick **Auto Confirm User**. The first user created becomes **Admin** automatically.
4. **Authentication → Sign In / Providers**: turn **off** "Allow new users to sign up",
   so only people you add can log in.
5. **Project Settings → API Keys**: copy the **Project URL** and the **anon / publishable** key.
   Never use or share the *service_role / secret* key.

### 1b. Database updates
Run each update file in `supabase/` once, in number order, the same way as the setup script:
- `002_account_suggestions.sql` — donor account suggestions + AAC barcode rule and history
- `003_companies_and_barcode_rules.sql` — the 26 voucher companies and their barcode rules
- `004_voucher_date_rules.sql` — issue-date validity (AAC: 6 months) and urgent warnings
- `005_ai_reading.sql` — AI reading: stored AI guesses, on/off switch, accuracy figures
- `006_written_date.sql` — two date types (AAC: valid 6 months from date; others: date written, no expiry) and post-dated vouchers
- `007_ai_hints_hebrew_dates.sql` — AI hints and close-ups per company, Hebrew date text
- `008_sending_receiving.sql` — voucher pool: sent / received / paid details
- `009_company_from_number.sql` — recognise the company from the voucher number (number history + patterns, loaded from the London sheet)
- `010_duplicates.sql` — duplicates linked to the voucher they match; removing and restoring vouchers
- `011_miffal_barcodes.sql` — Miffal barcode rule (voucher number in two parts, amount code)
- `012_cosmon_belz.sql` — Cosmon Belz: dummy barcode ignored, AI hints for the printed voucher number
- `013_small_pictures.sql` — small copies of voucher pictures for fast pages
- `014_ai_corrections.sql` — records every correction people make to barcode / AI values, so the AI learns from them
- `015_bat_voucher_numbers.sql` — BAT voucher numbers keep their leading zeros; option per company; pending BAT vouchers corrected
- `016_marked_places.sql` — places people mark on the picture (📍) to teach the AI where details are
- `017_picture_previews.sql` — tiny previews of every voucher picture in the database, so pictures show at once for everyone
- `018_voucher_validity.sql` — a voucher's own validity (stamps like "VALID FOR 3 MONTHS")
- `fix_missing_columns.sql` — catch-up: adds anything from 004–008 that is missing

### 1c. AI reading function
Supabase → Edge Functions: secret `ANTHROPIC_API_KEY`, and a function `read-voucher` with the code in `supabase/functions/read-voucher/index.ts`.
When this file changes, open the function → Code → paste the new version → Deploy.

How the AI learns: before reading a voucher it is shown up to 3 checked vouchers of the same company (ones it got wrong first) and the patterns found in that company's checked vouchers; answers that don't fit get a second reading with the strong model, and doubtful boxes are marked orange. **AI reading → Test the AI** scores the methods on vouchers already checked.

### 2. Website (Cloudflare Pages)
1. Cloudflare → **Workers & Pages → Create → Pages → Import an existing Git repository**.
2. Connect GitHub and choose the **voucherflow** repository.
3. Build settings:
   - Framework preset: **Vite** (or None)
   - Build command: `npm run build`
   - Build output directory: `dist`
4. **Environment variables** (add both):
   - `VITE_SUPABASE_URL` = your Project URL
   - `VITE_SUPABASE_ANON_KEY` = your anon / publishable key
5. **Save and Deploy**. The site appears at `https://voucherflow-xxx.pages.dev`.

### 3. First use
1. Log in, go to **Companies**, add your voucher companies (barcode rules optional).
2. **Batches → New batch**, enter the collector reference, upload voucher images, validate.

## Adding users
Supabase → Authentication → Users → Add user (tick Auto Confirm). They appear in the app's
**Users** page as *Batch entry*; an admin can change their role or deactivate them there.
