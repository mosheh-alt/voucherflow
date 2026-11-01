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
