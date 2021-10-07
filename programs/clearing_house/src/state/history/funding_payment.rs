use anchor_lang::prelude::*;

#[account(zero_copy)]
pub struct FundingPaymentHistory {
    head: u64,
    funding_rate_records: [FundingPaymentRecord; 1000],
}

impl Default for FundingPaymentHistory {
    fn default() -> Self {
        return FundingPaymentHistory {
            head: 0,
            funding_rate_records: [FundingPaymentRecord::default(); 1000],
        };
    }
}

impl FundingPaymentHistory {
    pub fn append(&mut self, pos: FundingPaymentRecord) {
        self.funding_rate_records[FundingPaymentHistory::index_of(self.head)] = pos;
        self.head = (self.head + 1) % 1000;
    }

    pub fn index_of(counter: u64) -> usize {
        std::convert::TryInto::try_into(counter).unwrap()
    }

    pub fn next_record_id(&self) -> u128 {
        let prev_record_id = if self.head == 0 { 999 } else { self.head - 1 };
        let prev_record =
            &self.funding_rate_records[FundingPaymentHistory::index_of(prev_record_id)];
        return prev_record.record_id + 1;
    }
}

// FundingPaymentRecord
#[zero_copy]
#[derive(Default)]
pub struct FundingPaymentRecord {
    pub ts: i64,
    pub record_id: u128,
    pub user_authority: Pubkey,
    pub user: Pubkey,
    pub market_index: u64,
    pub funding_payment: i128,
    pub base_asset_amount: i128,
    pub user_last_cumulative_funding: i128,
    pub amm_cumulative_funding: i128,
}