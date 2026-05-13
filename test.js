function extractOtpFromHtml(htmlContent) {
    if (!htmlContent) return null;

    // Normalize / unescape HTML entities
    const s = htmlContent.replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'");

    // Pattern -1: specific phrase for Rakuten
    const matchRakuten = s.match(/verification code is as follows:\s*(\d{6})/i);
    if (matchRakuten) return matchRakuten[1].trim();

    // Pattern 0: Extract OTP from element with class "otp"
    const pattern0 = /class\s*=\s*["'](?:[^"']*\s)?otp(?:\s[^"']*)?["'][^>]*>(\d{6})/is;
    let m = s.match(pattern0);
    if (m) return m[1].trim();

    // Pattern 1: your verification code is:
    const pattern1 = /your verification code is:<\/span><\/div><\/td><\/tr>.*?<div[^>]*><span>(\d{6})<\/span><\/div>/is;
    m = s.match(pattern1);
    if (m) return m[1].trim();

    // Pattern 2: verification code followed by 6 digits
    const pattern2 = /verification code.*?(\d{6})/is;
    m = s.match(pattern2);
    if (m) return m[1].trim();

    // Pattern 3: Find 6-digit codes but exclude hex color codes
    const pattern3 = /\b(\d{6})\b/g;
    let match;
    while ((match = pattern3.exec(s)) !== null) {
        const startPos = match.index;
        const sixDigitCode = match[1];

        // Check if it's part of a color code
        const prefix = s.substring(Math.max(0, startPos - 1), startPos);
        if (prefix === '#') continue;

        // Check for "color code" text nearby
        const nearbyText = s.substring(Math.max(0, startPos - 20), startPos).toLowerCase();
        if (nearbyText.includes('color') && nearbyText.includes('code')) continue;

        return sixDigitCode.trim();
    }

    return null;
}

console.log(extractOtpFromHtml(`Your Verification Code  Dear hikko0629@mineo.jp,  Your verification code is as follows:  976894  The verific`))