use crate::controller::position::PositionDirection;
use crate::error::{DriftResult, ErrorCode};
use crate::math::casting::Cast;
use crate::math::safe_math::SafeMath;

use crate::state::perp_market::{PerpMarket, AMM};
use crate::validate;
use solana_program::msg;

#[allow(clippy::comparison_chain)]
pub fn validate_perp_market(market: &PerpMarket) -> DriftResult {
    validate!(
        (market.amm.base_asset_amount_long + market.amm.base_asset_amount_short)
            == market.amm.base_asset_amount_with_amm
                + market.amm.base_asset_amount_with_unsettled_lp,
        ErrorCode::InvalidAmmDetected,
        "Market NET_BAA Error: 
        market.amm.base_asset_amount_long={}, 
        + market.amm.base_asset_amount_short={} 
        != 
        market.amm.base_asset_amount_with_amm={}
        +  market.amm.base_asset_amount_with_unsettled_lp={}",
        market.amm.base_asset_amount_long,
        market.amm.base_asset_amount_short,
        market.amm.base_asset_amount_with_amm,
        market.amm.base_asset_amount_with_unsettled_lp,
    )?;

    validate!(
        market.amm.peg_multiplier > 0,
        ErrorCode::InvalidAmmDetected,
        "peg_multiplier out of wack"
    )?;

    validate!(
        market.amm.sqrt_k > market.amm.base_asset_amount_with_amm.unsigned_abs(),
        ErrorCode::InvalidAmmDetected,
        "k out of wack: k={}, net_baa={}",
        market.amm.sqrt_k,
        market.amm.base_asset_amount_with_amm
    )?;

    validate!(
        market.amm.sqrt_k >= market.amm.base_asset_reserve
            || market.amm.sqrt_k >= market.amm.quote_asset_reserve,
        ErrorCode::InvalidAmmDetected,
        "k out of wack: k={}, bar={}, qar={}",
        market.amm.sqrt_k,
        market.amm.base_asset_reserve,
        market.amm.quote_asset_reserve
    )?;

    validate!(
        market.amm.sqrt_k >= market.amm.user_lp_shares,
        ErrorCode::InvalidAmmDetected,
        "market.amm.sqrt_k < market.amm.user_lp_shares: {} < {}",
        market.amm.sqrt_k,
        market.amm.user_lp_shares,
    )?;

    let invariant_sqrt_u192 = crate::bn::U192::from(market.amm.sqrt_k);
    let invariant = invariant_sqrt_u192.safe_mul(invariant_sqrt_u192)?;
    let quote_asset_reserve = invariant
        .safe_div(crate::bn::U192::from(market.amm.base_asset_reserve))?
        .try_to_u128()?;

    let rounding_diff = quote_asset_reserve
        .cast::<i128>()?
        .safe_sub(market.amm.quote_asset_reserve.cast()?)?
        .abs();

    validate!(
        rounding_diff <= 10,
        ErrorCode::InvalidAmmDetected,
        "qar/bar/k out of wack: k={}, bar={}, qar={}, qar'={} (rounding: {})",
        invariant,
        market.amm.base_asset_reserve,
        market.amm.quote_asset_reserve,
        quote_asset_reserve,
        rounding_diff
    )?;

    // todo
    if market.amm.base_spread > 0 {
        // bid quote/base < reserve q/b
        validate!(
            market.amm.bid_base_asset_reserve >= market.amm.base_asset_reserve
                && market.amm.bid_quote_asset_reserve <= market.amm.quote_asset_reserve,
            ErrorCode::InvalidAmmDetected,
            "bid reserves out of wack: {} -> {}, quote: {} -> {}",
            market.amm.bid_base_asset_reserve,
            market.amm.base_asset_reserve,
            market.amm.bid_quote_asset_reserve,
            market.amm.quote_asset_reserve
        )?;

        // ask quote/base > reserve q/b
        validate!(
            market.amm.ask_base_asset_reserve <= market.amm.base_asset_reserve
                && market.amm.ask_quote_asset_reserve >= market.amm.quote_asset_reserve,
            ErrorCode::InvalidAmmDetected,
            "ask reserves out of wack base: {} -> {}, quote: {} -> {}",
            market.amm.ask_base_asset_reserve,
            market.amm.base_asset_reserve,
            market.amm.ask_quote_asset_reserve,
            market.amm.quote_asset_reserve
        )?;
    }

    validate!(
        market.amm.long_spread + market.amm.short_spread >= market.amm.base_spread,
        ErrorCode::InvalidAmmDetected,
        "long_spread + short_spread < base_spread: {} + {} < {}",
        market.amm.long_spread,
        market.amm.short_spread,
        market.amm.base_spread
    )?;

    validate!(
        market
            .amm
            .long_spread
            .safe_add(market.amm.short_spread)?
            .cast::<u64>()?
            <= market.amm.max_spread.cast::<u64>()?.max(
                market
                    .amm
                    .last_oracle_reserve_price_spread_pct
                    .unsigned_abs()
            ),
        ErrorCode::InvalidAmmDetected,
        "long_spread + short_spread > max_spread: {} + {} < {}.max({})",
        market.amm.long_spread,
        market.amm.short_spread,
        market.amm.max_spread,
        market
            .amm
            .last_oracle_reserve_price_spread_pct
            .unsigned_abs()
    )?;

    if market.amm.base_asset_amount_with_amm > 0 {
        // users are long = removed base and added quote = qar increased
        // bid quote/base < reserve q/b
        validate!(
            market.amm.terminal_quote_asset_reserve < market.amm.quote_asset_reserve,
            ErrorCode::InvalidAmmDetected,
            "terminal_quote_asset_reserve out of wack"
        )?;
    } else if market.amm.base_asset_amount_with_amm < 0 {
        validate!(
            market.amm.terminal_quote_asset_reserve > market.amm.quote_asset_reserve,
            ErrorCode::InvalidAmmDetected,
            "terminal_quote_asset_reserve out of wack (terminal <) {} > {}",
            market.amm.terminal_quote_asset_reserve,
            market.amm.quote_asset_reserve
        )?;
    } else {
        validate!(
            market.amm.terminal_quote_asset_reserve == market.amm.quote_asset_reserve,
            ErrorCode::InvalidAmmDetected,
            "terminal_quote_asset_reserve out of wack {}!={}",
            market.amm.terminal_quote_asset_reserve,
            market.amm.quote_asset_reserve
        )?;
    }

    if market.amm.base_spread > 0 {
        validate!(
            market.amm.max_spread > market.amm.base_spread
                && market.amm.max_spread < market.margin_ratio_initial * 100,
            ErrorCode::InvalidAmmDetected,
            "invalid max_spread",
        )?;
    }

    Ok(())
}

#[allow(clippy::comparison_chain)]
pub fn validate_amm_account_for_fill(amm: &AMM, direction: PositionDirection) -> DriftResult {
    if direction == PositionDirection::Long {
        validate!(
            amm.base_asset_reserve >= amm.min_base_asset_reserve,
            ErrorCode::InvalidAmmForFillDetected,
            "Market baa below min_base_asset_reserve: {} < {}",
            amm.base_asset_reserve,
            amm.min_base_asset_reserve,
        )?;
    }

    if direction == PositionDirection::Short {
        validate!(
            amm.base_asset_reserve <= amm.max_base_asset_reserve,
            ErrorCode::InvalidAmmForFillDetected,
            "Market baa above max_base_asset_reserve"
        )?;
    }

    Ok(())
}
