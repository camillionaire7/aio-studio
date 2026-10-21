'use strict';
// Name pools for the profile builder.

const MALE_FIRST_NAMES = `James John Robert Michael William David Richard Joseph Thomas Charles Christopher Daniel Matthew Anthony Mark
Donald Steven Paul Andrew Joshua Kenneth Kevin Brian George Timothy Ronald Edward Jason Jeffrey Ryan Jacob Gary Nicholas Eric
Jonathan Stephen Larry Justin Scott Brandon Benjamin Samuel Gregory Alexander Patrick Frank Raymond Jack Dennis Jerry Tyler
Aaron Jose Adam Nathan Henry Zachary Douglas Peter Kyle Noah Ethan Jeremy Walter Christian Keith Roger Terry Austin Sean
Gerald Carl Harold Dylan Arthur Lawrence Jordan Jesse Bryan Billy Bruce Gabriel Joe Logan Alan Juan Albert Willie Elijah
Wayne Randy Vincent Philip Eugene Russell Bobby Harry Johnny Howard Martin Diego Mateo Luis Carlos Miguel Javier Ricardo`
  .split(/\s+/).filter(Boolean);

const FEMALE_FIRST_NAMES = `Mary Patricia Jennifer Linda Elizabeth Barbara Susan Jessica Sarah Karen Lisa Nancy Betty Margaret Sandra Ashley Kimberly
Emily Donna Michelle Carol Amanda Dorothy Melissa Deborah Stephanie Rebecca Sharon Laura Cynthia Kathleen Amy Angela Shirley
Anna Brenda Pamela Emma Nicole Helen Samantha Katherine Christine Debra Rachel Carolyn Janet Catherine Maria Heather Diane
Ruth Julie Olivia Joyce Virginia Victoria Kelly Lauren Christina Joan Evelyn Judith Megan Andrea Cheryl Hannah Jacqueline
Martha Gloria Teresa Ann Sara Madison Frances Kathryn Janice Jean Abigail Alice Julia Judy Sophia Grace Denise Amber Doris
Marilyn Danielle Beverly Isabella Theresa Diana Natalie Brittany Charlotte Marie Kayla Alexis Lori Sofia Camila Valeria`
  .split(/\s+/).filter(Boolean);

const FIRST_NAMES = [...MALE_FIRST_NAMES, ...FEMALE_FIRST_NAMES];

const LAST_NAMES = `Smith Johnson Williams Brown Jones Garcia Miller Davis Rodriguez Martinez Hernandez Lopez Gonzalez Wilson Anderson
Thomas Taylor Moore Jackson Martin Lee Perez Thompson White Harris Sanchez Clark Ramirez Lewis Robinson Walker Young Allen
King Wright Scott Torres Nguyen Hill Flores Green Adams Nelson Baker Hall Rivera Campbell Mitchell Carter Roberts Gomez
Phillips Evans Turner Diaz Parker Cruz Edwards Collins Reyes Stewart Morris Morales Murphy Cook Rogers Gutierrez Ortiz
Morgan Cooper Peterson Bailey Reed Kelly Howard Ramos Kim Cox Ward Richardson Watson Brooks Chavez Wood James Bennett
Gray Mendoza Ruiz Hughes Price Alvarez Castillo Sanders Patel Myers Long Ross Foster Jimenez Powell Jenkins Perry Russell
Sullivan Bell Coleman Butler Henderson Barnes Gonzales Fisher Vasquez Simmons Romero Jordan Patterson Alexander Hamilton
Graham Reynolds Griffin Wallace Moreno West Cole Hayes Bryant Herrera Gibson Ellis Tran Medina Aguilar Stevens Murray Ford
Castro Marshall Owens Harrison Fernandez McDonald Woods Washington Kennedy Wells Vargas Henry Chen Freeman Webb Tucker
Guzman Burns Crawford Olson Simpson Porter Hunter Gordon Mendez Silva Shaw Snyder Mason Dixon Munoz Hunt Hicks Holmes
Palmer Wagner Black Robertson Boyd Rose Stone Salazar Fox Warren Mills Meyer Rice Schmidt Garza Daniels Ferguson Nichols`
  .split(/\s+/).filter(Boolean);

function shuffle(arr, rng = Math.random) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// n distinct picks (repeats only if n exceeds the pool size).
function pickUnique(pool, n, rng = Math.random) {
  const out = [];
  while (out.length < n) out.push(...shuffle([...new Set(pool)], rng));
  return out.slice(0, n);
}

module.exports = { FIRST_NAMES, MALE_FIRST_NAMES, FEMALE_FIRST_NAMES, LAST_NAMES, pickUnique, shuffle };
