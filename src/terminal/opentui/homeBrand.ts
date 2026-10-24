export interface HomeBrand {
  mark: string
  subline: string
}

export function homeBrand(productName: string): HomeBrand {
  const words = productName.trim().split(/\s+/u).filter(Boolean)
  const firstWord = words[0] || 'X'
  const mark = (words.length > 1 ? Array.from(firstWord)[0] || 'X' : firstWord).slice(0, 12).toUpperCase()
  const subline = words.slice(1).join(' ').toUpperCase().split('').join(' ')
  return { mark, subline }
}
