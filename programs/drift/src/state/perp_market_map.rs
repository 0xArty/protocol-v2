use anchor_lang::accounts::account_loader::AccountLoader;
use std::cell::{Ref, RefMut};
use std::collections::{BTreeMap, BTreeSet};
use std::iter::Peekable;
use std::slice::Iter;

use anchor_lang::prelude::AccountInfo;

use anchor_lang::Discriminator;
use arrayref::array_ref;

use crate::error::{DriftResult, ErrorCode};
use crate::state::perp_market::PerpMarket;
use crate::state::user::PerpPositions;

use solana_program::msg;

pub struct PerpMarketMap<'a>(pub BTreeMap<u16, AccountLoader<'a, PerpMarket>>);

impl<'a> PerpMarketMap<'a> {
    pub fn get_ref(&self, market_index: &u16) -> DriftResult<Ref<PerpMarket>> {
        self.0
            .get(market_index)
            .ok_or_else(|| {
                msg!("market not found: {}", market_index);
                ErrorCode::MarketNotFound
            })?
            .load()
            .or(Err(ErrorCode::UnableToLoadMarketAccount))
    }

    pub fn get_ref_mut(&self, market_index: &u16) -> DriftResult<RefMut<PerpMarket>> {
        self.0
            .get(market_index)
            .ok_or_else(|| {
                msg!("market not found: {}", market_index);
                ErrorCode::MarketNotFound
            })?
            .load_mut()
            .or(Err(ErrorCode::UnableToLoadMarketAccount))
    }

    pub fn load<'b, 'c>(
        writable_markets: &'b MarketSet,
        account_info_iter: &'c mut Peekable<Iter<AccountInfo<'a>>>,
    ) -> DriftResult<PerpMarketMap<'a>> {
        let mut perp_market_map: PerpMarketMap = PerpMarketMap(BTreeMap::new());

        let market_discriminator: [u8; 8] = PerpMarket::discriminator();
        while let Some(account_info) = account_info_iter.peek() {
            let data = account_info
                .try_borrow_data()
                .or(Err(ErrorCode::CouldNotLoadMarketData))?;

            let expected_data_len = std::mem::size_of::<PerpMarket>() + 8;
            if data.len() < expected_data_len {
                break;
            }

            let account_discriminator = array_ref![data, 0, 8];
            if account_discriminator != &market_discriminator {
                break;
            }

            // market index 8 bytes from the back of the account
            let market_index = u16::from_le_bytes(*array_ref![data, expected_data_len - 8, 2]);

            let account_info = account_info_iter.next().unwrap();

            let is_writable = account_info.is_writable;
            if writable_markets.contains(&market_index) && !is_writable {
                return Err(ErrorCode::MarketWrongMutability);
            }

            let account_loader: AccountLoader<PerpMarket> =
                AccountLoader::try_from(account_info).or(Err(ErrorCode::InvalidMarketAccount))?;

            perp_market_map.0.insert(market_index, account_loader);
        }

        Ok(perp_market_map)
    }
}

#[cfg(test)]
impl<'a> PerpMarketMap<'a> {
    pub fn load_one<'c>(
        account_info: &'c AccountInfo<'a>,
        must_be_writable: bool,
    ) -> DriftResult<PerpMarketMap<'a>> {
        let mut perp_market_map: PerpMarketMap = PerpMarketMap(BTreeMap::new());

        let data = account_info
            .try_borrow_data()
            .or(Err(ErrorCode::CouldNotLoadMarketData))?;

        let expected_data_len = std::mem::size_of::<PerpMarket>() + 8;
        if data.len() < expected_data_len {
            return Err(ErrorCode::CouldNotLoadMarketData);
        }

        let market_discriminator: [u8; 8] = PerpMarket::discriminator();
        let account_discriminator = array_ref![data, 0, 8];
        if account_discriminator != &market_discriminator {
            return Err(ErrorCode::CouldNotLoadMarketData);
        }

        // market index 8 bytes from back of account
        let market_index = u16::from_le_bytes(*array_ref![data, expected_data_len - 8, 2]);

        let is_writable = account_info.is_writable;
        let account_loader: AccountLoader<PerpMarket> =
            AccountLoader::try_from(account_info).or(Err(ErrorCode::InvalidMarketAccount))?;

        if must_be_writable && !is_writable {
            return Err(ErrorCode::MarketWrongMutability);
        }

        perp_market_map.0.insert(market_index, account_loader);

        Ok(perp_market_map)
    }

    pub fn empty() -> Self {
        PerpMarketMap(BTreeMap::new())
    }

    pub fn load_multiple<'c>(
        account_infos: Vec<&'c AccountInfo<'a>>,
        must_be_writable: bool,
    ) -> DriftResult<PerpMarketMap<'a>> {
        let mut perp_market_map: PerpMarketMap = PerpMarketMap(BTreeMap::new());

        for account_info in account_infos {
            let data = account_info
                .try_borrow_data()
                .or(Err(ErrorCode::CouldNotLoadMarketData))?;

            let expected_data_len = std::mem::size_of::<PerpMarket>() + 8;
            if data.len() < expected_data_len {
                return Err(ErrorCode::CouldNotLoadMarketData);
            }

            let market_discriminator: [u8; 8] = PerpMarket::discriminator();
            let account_discriminator = array_ref![data, 0, 8];
            if account_discriminator != &market_discriminator {
                return Err(ErrorCode::CouldNotLoadMarketData);
            }

            // market index 8 bytes from back of account
            let market_index = u16::from_le_bytes(*array_ref![data, expected_data_len - 8, 2]);

            let is_writable = account_info.is_writable;
            let account_loader: AccountLoader<PerpMarket> =
                AccountLoader::try_from(account_info).or(Err(ErrorCode::InvalidMarketAccount))?;

            if must_be_writable && !is_writable {
                return Err(ErrorCode::MarketWrongMutability);
            }

            perp_market_map.0.insert(market_index, account_loader);
        }

        Ok(perp_market_map)
    }
}

pub type MarketSet = BTreeSet<u16>;

pub fn get_writable_perp_market_set(market_index: u16) -> MarketSet {
    let mut writable_markets = MarketSet::new();
    writable_markets.insert(market_index);
    writable_markets
}

pub fn get_market_set_from_list(market_indexes: [u16; 5]) -> MarketSet {
    let mut writable_markets = MarketSet::new();
    for market_index in market_indexes.iter() {
        if *market_index == 100 {
            continue; // todo
        }
        writable_markets.insert(*market_index);
    }
    writable_markets
}

pub fn get_market_set_for_user_positions(user_positions: &PerpPositions) -> MarketSet {
    let mut writable_markets = MarketSet::new();
    for position in user_positions.iter() {
        writable_markets.insert(position.market_index);
    }
    writable_markets
}

pub fn get_market_set_for_user_positions_and_order(
    user_positions: &PerpPositions,
    market_index: u16,
) -> MarketSet {
    let mut writable_markets = MarketSet::new();
    for position in user_positions.iter() {
        writable_markets.insert(position.market_index);
    }
    writable_markets.insert(market_index);

    writable_markets
}
