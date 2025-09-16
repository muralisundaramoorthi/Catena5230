/*

Name:   catena-message-0x50-port1-decoder-ttn.js

Function:
    This function decodes the record (port 1, format 0x50) sent by the
    MCCI Catena 5230 Rev A .

Copyright and License:
    See accompanying LICENSE file

Author:
    Murali , MCCI Corporation   March 2025

*/

// calculate dewpoint (degrees C) given temperature (C) and relative humidity (0..100)
// from http://andrew.rsmas.miami.edu/bmcnoldy/Humidity.html
// rearranged for efficiency and to deal sanely with very low (< 1%) RH
function dewpoint(t, rh)
    {
    var c1 = 243.04;
    var c2 = 17.625;
    var h = rh / 100;
    if (h <= 0.01)
        h = 0.01;
    else if (h > 1.0)
        h = 1.0;

    var lnh = Math.log(h);
    var tpc1 = t + c1;
    var txc2 = t * c2;
    var txc2_tpc1 = txc2 / tpc1;

    var tdew = c1 * (lnh + txc2_tpc1) / (c2 - lnh - txc2_tpc1);
    return tdew;
    }

/*

Name:   CalculateHeatIndex()

Description:
        Calculate the NWS heat index given dry-bulb T and RH

Definition:
        function CalculateHeatIndex(t, rh) -> value or null

Description:
        T is a Farentheit temperature in [76,120]; rh is a
        relative humidity in [0,100]. The heat index is computed
        and returned; or an error is returned.

Returns:
        number => heat index in Farenheit.
        null => error.

References:
        https://github.com/mcci-catena/heat-index/
        https://www.wpc.ncep.noaa.gov/html/heatindex_equation.shtml

        Results was checked against the full chart at iweathernet.com:
        https://www.iweathernet.com/wxnetcms/wp-content/uploads/2015/07/heat-index-chart-relative-humidity-2.png

        The MCCI-Catena heat-index site has a test js script to generate CSV to
        match the chart, a spreadsheet that recreates the chart, and a
        spreadsheet that compares results.

*/

function CalculateHeatIndex(t, rh)
    {
    var tRounded = Math.floor(t + 0.5);

    // return null outside the specified range of input parameters
    if (tRounded < 76 || tRounded > 126)
        return null;
    if (rh < 0 || rh > 100)
        return null;

    // according to the NWS, we try this first, and use it if we can
    var tHeatEasy = 0.5 * (t + 61.0 + ((t - 68.0) * 1.2) + (rh * 0.094));

    // The NWS says we use tHeatEasy if (tHeatHeasy + t)/2 < 80.0
    // This is the same computation:
    if ((tHeatEasy + t) < 160.0)
            return tHeatEasy;

    // need to use the hard form, and possibly adjust.
    var t2 = t * t;         // t squared
    var rh2 = rh * rh;      // rh squared
    var tResult =
        -42.379 +
        (2.04901523 * t) +
        (10.14333127 * rh) +
        (-0.22475541 * t * rh) +
        (-0.00683783 * t2) +
        (-0.05481717 * rh2) +
        (0.00122874 * t2 * rh) +
        (0.00085282 * t * rh2) +
        (-0.00000199 * t2 * rh2);

    // these adjustments come from the NWA page, and are needed to
    // match the reference table.
    var tAdjust;
    if (rh < 13.0 && 80.0 <= t && t <= 112.0)
        tAdjust = -((13.0 - rh) / 4.0) * Math.sqrt((17.0 - Math.abs(t - 95.0)) / 17.0);
    else if (rh > 85.0 && 80.0 <= t && t <= 87.0)
        tAdjust = ((rh - 85.0) / 10.0) * ((87.0 - t) / 5.0);
    else
        tAdjust = 0;

    // apply the adjustment
    tResult += tAdjust;

    // finally, the reference tables have no data above 183 (rounded),
    // so filter out answers that we have no way to vouch for.
    if (tResult >= 183.5)
        return null;
    else
        return tResult;
    }

function CalculateHeatIndexCelsius(t, rh)
    {
    var result = CalculateHeatIndex(t, rh);
    if (result !== null)
        {
        // convert to celsius.
        result = (result - 32) * 5 / 9;
        }
    return result;
    }

function DecodeU16(Parse)
    {
    var i = Parse.i;
    var bytes = Parse.bytes;
    var raw = (bytes[i] << 8) + bytes[i + 1];
    Parse.i = i + 2;
    return raw;
    }

function DecodeI16(Parse)
    {
    var Vraw = DecodeU16(Parse);

    // interpret uint16 as an int16 instead.
    if (Vraw & 0x8000)
        Vraw += -0x10000;

    return Vraw;
    }

function DecodeU32(Parse)
    {
    var i = Parse.i;
    var bytes = Parse.bytes;

    var result = (bytes[i + 0] << 24)+ (bytes[i + 1] << 16) + (bytes[i + 2] << 8) + bytes[i + 3];
    Parse.i = i + 4;

    return result;
    }

function DecodeV(Parse)
    {
    return DecodeI16(Parse) / 4096.0;
    }

function DecodeUflt16(Parse)
    {
        var rawUflt16 = DecodeU16(Parse);
        var exp1 = rawUflt16 >> 12;
        var mant1 = (rawUflt16 & 0xFFF) / 4096.0;
        var f_unscaled = mant1 * Math.pow(2, exp1 - 15);
        return f_unscaled;
    }


function DecodeSflt16(Parse) {
    var rawSflt16 = DecodeU16(Parse);

    // special case minus zero:
    if (rawSflt16 == 0x8000)
        return -0.0;

    // extract the sign.
    var sSign = ((rawSflt16 & 0x8000) != 0) ? -1 : 1;

    // extract the exponent
    var exp1 = (rawSflt16 >> 11) & 0xF;

    // extract the "mantissa" (the fractional part)
    var mant1 = (rawSflt16 & 0x7FF) / 2048.0;

    // convert back to a floating point number. We hope
    // that Math.pow(2, k) is handled efficiently by
    // the JS interpreter! If this is time critical code,
    // you can replace by a suitable shift and divide.
    var f_unscaled = sSign * mant1* Math.pow(2, exp1 - 15);

    return f_unscaled;
}

function DecodeU24(Parse) {
    var i = Parse.i;
    var bytes = Parse.bytes;

    var result = (bytes[i] << 16) + (bytes[i + 1] << 8) + bytes[i + 2];
    Parse.i = i + 3;

    return result;
}

function DecodeSflt24(Parse)
    {
    var rawSflt24 = DecodeU24(Parse);
    // rawSflt24 is the 3-byte number decoded from wherever;
    // it's in range 0..0xFFFFFF
    // bit 23 is the sign bit
    // bits 22..16 are the exponent
    // bits 15..0 are the the mantissa. Unlike IEEE format,
    // the msb is explicit; this means that numbers
    // might not be normalized, but makes coding for
    // underflow easier.
    // As with IEEE format, negative zero is possible, so
    // we special-case that in hopes that JavaScript will
    // also cooperate.

    // extract sign, exponent, mantissa
    var bSign     = (rawSflt24 & 0x800000) ? true : false;
    var uExp      = (rawSflt24 & 0x7F0000) >> 16;
    var uMantissa = (rawSflt24 & 0x00FFFF);

    // if non-numeric, return appropriate result.
    if (uExp === 0x7F) {
        if (uMantissa === 0)
            return bSign ? Number.NEGATIVE_INFINITY
                    : Number.POSITIVE_INFINITY;
        else
            return Number.NaN;
    // else unless denormal, set the 1.0 bit
    } else if (uExp !== 0) {
        uMantissa += 0x010000;
    } else { // denormal: exponent is the minimum
        uExp = 1;
    }

    // make a floating mantissa in [0,2); usually [1,2), but
    // sometimes (0,1) for denormals, and exactly zero for zero.
    var mantissa = uMantissa / 0x010000;

    // apply the exponent.
    mantissa = Math.pow(2, uExp - 63) * mantissa;

    // apply sign and return result.
    return bSign ? -mantissa : mantissa;
    }

function DecodeLux(Parse) {
    return DecodeSflt24(Parse);
}

    

/*

Name:   DecodeDownlinkResponse(bytes)

Function:
        Decode the downlink response transmitted by device.

Definition:
        DecodeDownlinkResponse(
                bytes
                );

Description:
        A function to decode the port 3 uplink data in a human readable way.

Return:
        Returns decoded data

*/

function DecodeDownlinkResponse(bytes)
    {
    // Decode an uplink message from a buffer
    // (array) of bytes to an object of fields.
    var decoded = {};

    // an object to help us parse.
    var Parse = {};
    Parse.bytes = bytes;
    // i is used as the index into the message. Start with the flag byte.
    Parse.i = 0;

    // fetch the bitmap.
    var command = bytes[Parse.i++];

    if (command === 0x01)
        {
        // appliaction specific
        }

    else if (command === 0x02)
        {
        // Reset do not send a reply back.
        }

    else if (command === 0x03)
        {
        // SW version and HW details.
        decoded.ResponseType = "Device Version";

        var responseError = bytes[Parse.i++];
        if (responseError === 0)
            decoded.Response = "Success";
        else if (responseError === 1)
            decoded.Response = "Invalid Length";
        else if (responseError === 2)
            decoded.Response = "Failure";

        var vMajor = bytes[Parse.i++];
        var vMinor = bytes[Parse.i++];
        var vPatch = bytes[Parse.i++];
        var vLocal = bytes[Parse.i++];
        decoded.AppVersion = "V" + vMajor + "." + vMinor + "." + vPatch + "." + vLocal;

        var Model = DecodeU16(Parse);
        var Rev = bytes[Parse.i++];
        if (!(Model === 0))
            {
            decoded.Model = Model;
            if (Rev === 0)
                decoded.Rev = "A";
            else if (Rev === 1)
                decoded.Rev = "B";
            else if (Rev === 2)
                decoded.Rev = "C";
            else if (Rev === 3)
                decoded.Rev = "D";
            else if (Rev === 4)
                decoded.Rev = "E";
            }
        else if (Model === 0)
            {
            decoded.Model = 5230;
            decoded.Rev = "Not Found";
            }
        }

    else if (command === 0x04)
        {
        // Reset/Set AppEUI.
        decoded.ResponseType = "AppEUI Set";

        var responseError = bytes[Parse.i++];
        if (responseError === 0)
            decoded.Response = "Success";
        else if (responseError === 1)
            decoded.Response = "Invalid Length";
        else if (responseError === 2)
            decoded.Response = "Failure";
        }

    else if (command === 0x05)
        {
        // Reset/Set AppKey.
        decoded.ResponseType = "AppKey set";

        var responseError = bytes[Parse.i++];
        if (responseError === 0)
            decoded.Response = "Success";
        else if (responseError === 1)
            decoded.Response = "Invalid Length";
        else if (responseError === 2)
            decoded.Response = "Failure";
        }

    else if (command === 0x06)
        {
        // Rejoin the network.
        decoded.ResponseType = "Rejoin";

        var responseError = bytes[Parse.i++];
        if (responseError === 0)
            decoded.Response = "Success";
        else if (responseError === 1)
            decoded.Response = "Invalid Length";
        else if (responseError === 2)
            decoded.Response = "Failure";
        }

    else if (command === 0x07)
        {
        // Uplink Interval for sensor data.
        decoded.ResponseType = "Uplink Interval";

        var responseError = bytes[Parse.i++];
        if (responseError === 0)
            decoded.Response = "Success";
        else if (responseError === 1)
            decoded.Response = "Invalid Length";
        else if (responseError === 2)
            decoded.Response = "Failure";

        decoded.UplinkInterval = DecodeU32(Parse);
        }

    return decoded;
    }

/*

Name:   Decoder(bytes, port)

Function:
        Decode the transmitted uplink data.

Definition:
        Decoder(
                bytes,
                port
                );

Description:
        A function to decode the uplink data in a  human readable way.

Return:
        Returns decoded data

*/

function Decoder(bytes, port)
    {
    // Decode an uplink message from a buffer
    // (array) of bytes to an object of fields.
    var decoded = {};

    if (port === 3)
        {
        decoded = DecodeDownlinkResponse(bytes);
        return decoded;
        }

    if (! (port === 1) && ! (port === 3) && ! (port === 4))
        return null;

    var uFormat = bytes[0];
    if (! (uFormat === 0x50))
        return null;

    // an object to help us parse.
    var Parse = {};
    Parse.bytes = bytes;
    // i is used as the index into the message. 
    Parse.i = 1;

    // fetch the bitmap.
    var flags = bytes[Parse.i++];

    if (flags & 0x1)
        {
        decoded.vBat = DecodeV(Parse);
        decoded.vBus = DecodeV(Parse);
        decoded.vSys = DecodeV(Parse);
        }

    if (flags & 0x2)
        {
        var vMajor = bytes[Parse.i++];
        var vMinor = bytes[Parse.i++];
        var vPatch = bytes[Parse.i++];
        var vLocal = bytes[Parse.i++];

        decoded.version = vMajor + "." + vMinor + "." + vPatch + "." + vLocal;
        }

    if (flags & 0x4)
        {
        var iBoot = bytes[Parse.i++];
        decoded.boot = iBoot;
        }

    if (flags & 0x8)
        {
        // we have temp, RH
        decoded.t = DecodeI16(Parse);
        decoded.rh = DecodeUflt16(Parse) * 100 / 65535.0;
        }

    if (flags & 0x10)
        {
        decoded.lux = DecodeLux(Parse);
        }

    if (flags & 0x20)
        {
        //Accelerometer
        decoded.tap = bytes[Parse.i];
        }

        // at this point, decoded has the real values.
        return decoded;
    }

var bytes;

if ("payload_raw" in msg)
    {
    // the console already decoded this
    bytes = msg.payload_raw;  // pick up data for convenience
    // msg.payload_fields still has the decoded data from ttn
    }
else
    {
    // no console decode
    bytes = msg.payload;  // pick up data for conveneince
    }

// try to decode.
var result = Decoder(bytes, msg.port);

if (result === null)
    {
    node.error("not port 1/4/fmt 0x50! port=" + msg.port.toString());
    if (port === 2) {
        if (Buffer.byteLength(bytes) > 0) {
            eMsg = eMsg + " fmt=" + bytes[0].toString();
        } else {
            eMsg = eMsg + " <no fmt byte>"
        }
    }
    node.error(eMsg);
    return;
    }
    

// now update msg with the new payload and new .local field
// the old msg.payload is overwritten.
msg.payload = result;
msg.local =
    {
    nodeType: "Catena 5230",
    platformType: "Catena 523x",
    radioType: "Murata",
    applicationName: "Environmental sensor fmt 0x50"
    };

return msg;