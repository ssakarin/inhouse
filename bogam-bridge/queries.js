'use strict';
const { ranges, failure } = require('../server/bogam-sync');

// No SQL supplied by the browser, configuration or network is ever executed.
// All SQL sent to BogamDB is a fixed SELECT with typed date parameters.
const accountSql = `SELECT
  CAST(CASE WHEN IS_SRVROLEMEMBER('sysadmin') = 0
    AND IS_MEMBER('db_owner') = 0 AND IS_MEMBER('db_datawriter') = 0
    AND NOT EXISTS (SELECT 1 FROM sys.fn_my_permissions(NULL, 'SERVER')
      WHERE permission_name NOT IN ('CONNECT SQL','VIEW ANY DATABASE','VIEW SERVER STATE','VIEW ANY DEFINITION'))
    AND NOT EXISTS (SELECT 1 FROM sys.fn_my_permissions(NULL, 'DATABASE')
      WHERE permission_name NOT IN ('CONNECT','SELECT','VIEW DEFINITION','VIEW DATABASE STATE','SHOWPLAN',
        'VIEW ANY COLUMN MASTER KEY DEFINITION','VIEW ANY COLUMN ENCRYPTION KEY DEFINITION'))
    AND NOT EXISTS (SELECT 1 FROM sys.schemas s
      CROSS APPLY sys.fn_my_permissions(QUOTENAME(s.name), 'SCHEMA') p
      WHERE s.name NOT IN ('sys','INFORMATION_SCHEMA')
        AND p.permission_name NOT IN ('SELECT','VIEW DEFINITION'))
    AND NOT EXISTS (SELECT 1 FROM sys.objects o
      CROSS APPLY sys.fn_my_permissions(QUOTENAME(SCHEMA_NAME(o.schema_id))+'.'+QUOTENAME(o.name), 'OBJECT') p
      WHERE o.is_ms_shipped = 0 AND p.permission_name NOT IN ('SELECT','VIEW DEFINITION'))
    THEN 1 ELSE 0 END AS bit) AS readOnlyVerified`;
const schemaSql = `SELECT TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH
  FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA='dbo'
  AND TABLE_NAME IN ('DigMast','DigAccept','DigBook','CustMast','Employe','DigBill','Account','DigSick','MediHanSick','CodeInsureItem','InsuComp') ORDER BY TABLE_NAME,ORDINAL_POSITION`;
const principalsSql = `SELECT p.name, p.type_desc, r.name AS role_name
  FROM sys.database_principals p LEFT JOIN sys.database_role_members m ON p.principal_id=m.member_principal_id
  LEFT JOIN sys.database_principals r ON m.role_principal_id=r.principal_id
  WHERE p.type IN ('S','U','G') AND p.principal_id > 4 ORDER BY p.name,r.name`;

function buildQuery(body, config) {
  const requested = ranges(body);
  if (config.mappingVerified !== true || !['yyyymmdd', 'date'].includes(config.dateStorage)) throw failure('SOURCE_NOT_CONFIGURED', 503);
  const sqlType = config.dateStorage === 'date' ? 'DateTime' : 'VarChar';
  const encode = value => config.dateStorage === 'date' ? value : value.replaceAll('-', '');
  const nextDay = value => new Date(Date.parse(value) + 86400000).toISOString().slice(0, 10);
  const parameters = {};
  for (const [prefix, period] of [['v', requested.visits], ['b', requested.bookings]]) {
    parameters[`${prefix}Start`] = { type: sqlType, value: encode(period.start) };
    parameters[`${prefix}End`] = { type: sqlType, value: encode(nextDay(period.end)) };
  }
  const visits = `SELECT TOP (10001)
    CONVERT(nvarchar(100), m.dm_DiagID) AS diagnosisId,
    CONVERT(nvarchar(100), m.dm_CustID) AS customerId,
    CONVERT(nvarchar(30), c.cm_ChartID) AS chartNo,
    CONVERT(nvarchar(100), c.cm_CustName) AS name,
    CONVERT(nvarchar(30), m.dm_DiagDate, 126) AS date,
    CONVERT(nvarchar(30), m.dm_DiagTime, 108) AS diagnosisTime,
    CONVERT(nvarchar(30), a.da_AccTime, 108) AS receptionTime,
    CONVERT(nvarchar(100), e.emp_Name) AS doctorName,
    m.dm_Age AS ageAtVisit, RTRIM(c.cm_Sex) AS sex, c.cm_HP AS mobile,
    CONVERT(nvarchar(30), a.da_Insure) AS insuranceCode,
    CONVERT(nvarchar(30), a.da_InsuKind) AS insuranceDetailCode,
    CONVERT(nvarchar(30), m.dm_DiagMode) AS visitModeCode,
    CONVERT(int, m.dm_NoneInsu) AS noneInsurance,
    ic.NameVariants AS insurerNameVariants, ic.CaptionVariants AS insurerCaptionVariants,
    ic.InsurerName AS insurerName, ic.InsurerCaption AS insurerCaption,
    s.RowCount AS primaryDiagnosisRows,
    CASE WHEN s.RowCount=1 THEN s.DiagnosisCode END AS diagnosisCode,
    dn.NameCount AS diagnosisNameVariants,
    CASE WHEN s.RowCount=1 AND dn.NameCount=1 THEN dn.DiagnosisName END AS diagnosisName,
    ac.RowCount AS accountRows,
    CASE WHEN ac.RowCount=1 THEN ac.Total END AS totalFee,
    bill.db_SumInsu AS claimAmount, bill.db_SumUser AS insuredCopay, bill.db_CommCost AS nonCoveredAmount
    FROM dbo.DigMast m
    LEFT JOIN dbo.DigAccept a ON a.da_DiagID=m.dm_DiagID AND a.da_CustID=m.dm_CustID AND a.da_AccDate=m.dm_DiagDate
    LEFT JOIN dbo.CustMast c ON c.cm_CustID=m.dm_CustID
    LEFT JOIN dbo.Employe e ON e.emp_Code=m.dm_DrEmp
    LEFT JOIN dbo.DigBill bill ON bill.db_DiagID=m.dm_DiagID
    OUTER APPLY (SELECT
      COUNT(DISTINCT RTRIM(CONVERT(nvarchar(max), i.inc_Name)) COLLATE Latin1_General_100_BIN2) AS NameVariants,
      COUNT(DISTINCT RTRIM(CONVERT(nvarchar(max), i.inc_Caption)) COLLATE Latin1_General_100_BIN2) AS CaptionVariants,
      MAX(RTRIM(CONVERT(nvarchar(max), i.inc_Name))) AS InsurerName,
      MAX(RTRIM(CONVERT(nvarchar(max), i.inc_Caption))) AS InsurerCaption
      FROM dbo.InsuComp i WHERE a.da_Insure=4 AND i.inc_Code=a.da_InsuKind) ic
    OUTER APPLY (SELECT COUNT(*) AS RowCount, MAX(ds.ds_HCode) AS DiagnosisCode, MAX(ds.ds_HNo) AS DiagnosisNo
      FROM dbo.DigSick ds WHERE ds.ds_DiagID=m.dm_DiagID AND ds.ds_Base=1) s
    OUTER APPLY (SELECT
      COUNT(DISTINCT LTRIM(RTRIM(CONVERT(nvarchar(max), h.ms_Name))) COLLATE Latin1_General_100_BIN2) AS NameCount,
      MAX(LTRIM(RTRIM(CONVERT(nvarchar(max), h.ms_Name)))) AS DiagnosisName
      FROM dbo.MediHanSick h
      WHERE s.RowCount=1 AND h.ms_Code=s.DiagnosisCode AND h.ms_No=s.DiagnosisNo
        AND NULLIF(LTRIM(RTRIM(CONVERT(nvarchar(max), h.ms_Name))), '') IS NOT NULL
        AND (NULLIF(LTRIM(RTRIM(CONVERT(nvarchar(30), h.ms_DueDate, 112))), '') IS NULL
          OR TRY_CONVERT(date, CONVERT(nvarchar(30), h.ms_DueDate, 112), 112)
            <= TRY_CONVERT(date, CONVERT(nvarchar(30), m.dm_DiagDate, 112), 112))
        AND (NULLIF(LTRIM(RTRIM(CONVERT(nvarchar(30), h.ms_ExpDate, 112))), '') IS NULL
          OR TRY_CONVERT(date, CONVERT(nvarchar(30), h.ms_ExpDate, 112), 112)
            >= TRY_CONVERT(date, CONVERT(nvarchar(30), m.dm_DiagDate, 112), 112))) dn
    OUTER APPLY (SELECT COUNT(*) AS RowCount, MAX(z.ac_TotSum) AS Total
      FROM dbo.Account z WHERE z.ac_DiagID=m.dm_DiagID AND z.ac_CustID=m.dm_CustID AND z.ac_AccDate=m.dm_DiagDate) ac
    WHERE m.dm_DiagDate >= @vStart AND m.dm_DiagDate < @vEnd`;
  const bookings = `SELECT TOP (10001)
    CONVERT(nvarchar(30), c.cm_ChartID) AS chartNo,
    CONVERT(nvarchar(100), c.cm_CustName) AS name,
    CONVERT(nvarchar(30), b.dbk_DiagDate, 126) AS date,
    CONVERT(nvarchar(30), b.dbk_DiagTime, 108) AS time,
    CONVERT(nvarchar(100), e.emp_Name) AS doctorName
    FROM dbo.DigBook b LEFT JOIN dbo.CustMast c ON c.cm_CustID=b.dbk_CustID
    LEFT JOIN dbo.Employe e ON e.emp_Code=b.dbk_DrEmp
    WHERE b.dbk_DiagDate >= @bStart AND b.dbk_DiagDate < @bEnd`;
  return { sql: `${accountSql};\n${visits};\n${bookings}`, parameters };
}
module.exports = { buildQuery, accountSql, schemaSql, principalsSql };
