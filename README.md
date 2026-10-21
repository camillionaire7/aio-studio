# PokeSluts AIO Convertr

Electron app that converts Hayha and Polar AIO profile and account files in both directions.

## Run

```
npm install
npm start
```

Drop a `.hayha` or Polar `.json` file onto the window. The file type (accounts or profiles, Hayha or Polar) is detected automatically, a masked preview is shown, and Save writes the converted file.

Build an installer with `npm run dist`. Run the converter tests with `npm test`.

## Main page

- **Recently converted** lists the files you saved (newest day first, with a **Show in folder** button). File names and counts only, never file contents. **Clear** empties the list.
- **Open Hayha / Open Polar** launch the apps. The app looks for them in the Start Menu, Desktop and install folders. If it cannot find one it asks you to choose the .exe or shortcut once and remembers it. The **⚙** button shows the paths in use and lets you change them.

## Profiles (Vault + Builder)

The **Profiles** button opens a page with two tabs.

- **Vault:** store addresses, credit cards, catch-all domains (pick one from a dropdown in the Builder, or type a new one and it is saved), and retailer accounts (pick the retailer, add one at a time or bulk import `email:password` lines; passwords are encrypted and never shown). Add cards one at a time, or bulk import lines like `nickname:number:MM:YY:CVV` (the nickname is optional, the year can be 2 or 4 digits). The vault is encrypted with your OS login and full card numbers never show on screen. Each card is *Available* or *In use*, and cards are listed under a date header (`10/19`) for the day you added them.
- **Builder:** pick the site (Target or Pokémon Center), an address, how many profiles, names (random first name, same or random last name), your catch-all domain, and which cards to use. It jigs the address, builds an email from each name, assigns one card per profile, then exports for **Hayha** or **Polar**. Exporting marks the cards used as *In use* and saves the batch under **Saved groups** (bottom of the Builder tab, also under date headers): click a group to see its profiles. Enter a **group name** and a **profile name prefix** (a prefix of `abc` gives `abc 1`, `abc 2`...). Phone can be a random valid number per profile, a number from an area code you type (random valid 7 digits per profile), one number for all, or none. Email can be built from names, as numbered accounts (`prefix` + number `@` domain), or with **Match vault accounts**, which uses the emails of the vault accounts you select for the chosen site (one per profile, in order). Saved groups keep only each card's last 4 digits, never the full number.

- **Editor:** import Hayha or Polar profile files (one or several; the type is detected). Each file is kept as a group, listed by the date you imported it (the vault stores them encrypted, and card numbers never show on screen). Click a group to see every profile in a list, with icons for duplicates inside the file: a warning triangle for the same address, and mail, card and person icons for the same email, card number or name. Click an icon at the top to show only those profiles. **Jig address** on a profile re-rolls its address as many times as you like (always from the address it was imported with, and never the same as another profile in the file); **Reset** puts the original back. **Fix addresses** re-jigs every profile that shares an address, keeping the first of each set. **Export Hayha / Export Polar** writes the edited profiles.

Address jigging is the same for every site. Everything is added at the end of **line 1** and **line 2 is always empty**. The house number and street name are never changed. Every line 1 in a batch is unique.

- **Input:** a raw line like `17161 Alva Rd unit 2814`, a vault address (a unit in line 2 is detected too), or `baseStreet` / `streetSuffix` / `existingUnit` fields. The unit is reduced to its core (`unit 2814` is `2814`, `APT 007H` is `7H`).
- **Street type:** rotates through full, full with period, abbreviated, abbreviated with period (`Street`, `Street.`, `St`, `St.`).
- **Address has a unit:** all combinations of street type, designator (none, APT, STE, Door, Floor, then Unit, Apt., Ste., Suite, Fl, Rm, #...) and leading zeros (`7H`, `07H`, `007H`), starting with a fixed priority order (`123 Example St. 7H`, `123 Example Street APT 7H`, `123 Example St. STE 7H`...). The same address always gives the same list, and at most 180 variations exist.
- **No unit:** each profile gets a made-up unit after the street type, such as `APT 2`, `STE 04`, `Door 8B` or `Floor 08B`. Small batches use APT, STE, Door and Floor; batches over 20 also use the extra designators.

These are commonly reported tricks, not guarantees, and retailers change their checks, so test a small batch first.

Optional extra jigs: phone numbers (same area code, valid exchange, random last 4) and first name (nickname, middle initial or doubled letter; last name never changed). Export as Hayha, Polar, or CSV (`Line 1, Line 2, City, State, Zip, Phone, First Name, Last Name`, no card data).

## Field mapping

**Accounts**

| Hayha | Polar |
| --- | --- |
| `username`, `password`, `id` | same |
| `site[].name` | `type` |
| `site[].value` | generated (lowercased type) |
| `groupId` | `accountGroup` (name you type in the app) |
| `status` | not stored (set to "Not Signed In" going to Hayha) |

A Hayha account with several sites becomes one Polar account per site; going back, same-login accounts are merged.

**Profiles**

| Hayha | Polar |
| --- | --- |
| `shipping.firstName` + `lastName` | `shippingAddress.name` |
| `shipping.address` / `address2` | `line1` / `line2` |
| `shipping.zipCode` | `postCode` |
| `shipping.state {shortCode, name}` | `state` (full name) |
| `cardInfo.holder` | `paymentDetails.nameOnCard` |
| `cardInfo.expYear` (number) | `cardExpYear` (string) |
| `cardInfo.cvv` | `cardCvv` |
| `sameAsBilling` | `sameBillingAndShippingAddress` |

## Known gaps

- Hayha requires billing and shipping to be the same address. Hayha to Polar copies the address to both; Polar to Hayha uses the shipping address and flags any profile whose Polar billing address differs.
- Encrypted Hayha profiles are skipped.
- Polar `cardType` is left blank (as in your sample); Polar-only flags are reset to defaults.
- Group names are not stored in Hayha files, only group IDs.
