-- Migration: Add isCardBased and cardUsageFee to MemberType
ALTER TABLE MemberTypes ADD COLUMN isCardBased BOOLEAN NOT NULL DEFAULT 0;
ALTER TABLE MemberTypes ADD COLUMN cardUsageFee DECIMAL(10,2) DEFAULT 0;