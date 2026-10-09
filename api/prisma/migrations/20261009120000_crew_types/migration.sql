-- Crew types for any trade, not just builders and helpers.
--
-- Phases price each of the company's worker types with their own daily rate
-- (crewRates), and a daily report's crew list becomes its only head-count.
-- Existing data is converted before the old columns go, so nothing is lost:
-- the old builder/helper rates become crewRates entries, and reports that
-- only had the two counts get an equivalent crew list.

-- Phase: per-type daily rates replace costPerBuilder / costPerHelper
ALTER TABLE `Phase` ADD COLUMN `crewRates` JSON NULL;

UPDATE `Phase` SET `crewRates` = JSON_OBJECT('builder', `costPerBuilder`, 'helper', `costPerHelper`)
  WHERE `costPerBuilder` > 0 AND `costPerHelper` > 0;
UPDATE `Phase` SET `crewRates` = JSON_OBJECT('builder', `costPerBuilder`)
  WHERE `costPerBuilder` > 0 AND `costPerHelper` = 0;
UPDATE `Phase` SET `crewRates` = JSON_OBJECT('helper', `costPerHelper`)
  WHERE `costPerBuilder` = 0 AND `costPerHelper` > 0;

ALTER TABLE `Phase` DROP COLUMN `costPerBuilder`, DROP COLUMN `costPerHelper`;

-- DailyUpdate: reports recorded before crew lists existed get one
UPDATE `DailyUpdate`
  SET `crew` = JSON_ARRAY(JSON_OBJECT('type', 'builder', 'count', `builders`), JSON_OBJECT('type', 'helper', 'count', `helpers`))
  WHERE `crew` IS NULL AND `builders` > 0 AND `helpers` > 0;
UPDATE `DailyUpdate`
  SET `crew` = JSON_ARRAY(JSON_OBJECT('type', 'builder', 'count', `builders`))
  WHERE `crew` IS NULL AND `builders` > 0 AND `helpers` = 0;
UPDATE `DailyUpdate`
  SET `crew` = JSON_ARRAY(JSON_OBJECT('type', 'helper', 'count', `helpers`))
  WHERE `crew` IS NULL AND `builders` = 0 AND `helpers` > 0;

ALTER TABLE `DailyUpdate` DROP COLUMN `builders`, DROP COLUMN `helpers`;
